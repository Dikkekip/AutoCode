#!/usr/bin/env python3
"""Observe native execution; alert the owner without replaying uncertain work."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(os.environ.get('AUTOCODE_WATCH_STATE_DIR', str(Path.home() / '.openclaw' / 'autonomy-watch')))
CLI = os.environ.get('OPENCLAW_COMMAND', 'openclaw')
BOARD = os.environ.get('AUTOCODE_BOARD_ID')
REPOSITORY = os.environ.get('AUTOCODE_REPOSITORY')

def alert_footer():
    return 'Technical blockers need diagnosis or repair; an operator pause is preserved. For an actual product decision use /ideas, then /idea approve ID or /idea skip ID. Tests, independent review and release checks remain required.'

def run(args, timeout=100):
    p = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(p.stderr[-500:] or p.stdout[-500:])
    x = json.loads(p.stdout)
    if x.get('ok') is False:
        raise RuntimeError(json.dumps(x.get('error', {})))
    return x

def call(method, params):
    return run([CLI, 'gateway', 'call', method, '--params', json.dumps(params), '--timeout', '60000', '--json'])

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if not BOARD or not REPOSITORY:
        raise RuntimeError('AUTOCODE_BOARD_ID and AUTOCODE_REPOSITORY are required')
    ROOT.mkdir(parents=True, exist_ok=True)
    lock = open(ROOT / 'watch.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    now = time.time()
    state_file = ROOT / 'watch-state.json'
    state = json.loads(state_file.read_text()) if state_file.exists() else {'alerts': {}}
    def save_state():
        if not args.dry_run:
            tmp = state_file.with_suffix('.tmp')
            tmp.write_text(json.dumps(state))
            os.replace(tmp, state_file)
    alerts = []
    try:
        cards = call('workboard.cards.list', {'boardId': BOARD})['cards']
        status = call('autocode.status', {'boardId': BOARD})
        workflows = {w['title']: w for w in status.get('workflows', [])}
        paused = status.get('control', {}).get('paused', False)
        # Maintenance time is not a stall. Reset on resume, including the first
        # observation after upgrading a state file without this control field.
        if paused or state.get('controlPaused') is not False:
            state['lastProgressAt'] = now
        state['controlPaused'] = paused
        signature = hashlib.sha256(json.dumps(sorted((w['id'], w.get('candidateSha'), w.get('verifiedSha'), w.get('mergedSha'), w.get('deployedSha')) for w in status.get('workflows', []))).encode()).hexdigest()
        if state.get('progressSignature') != signature:
            state.update(progressSignature=signature, lastProgressAt=now)
        if not status.get('control', {}).get('paused') and now - state.get('lastProgressAt', now) >= 7200:
            alerts.append(('no-code-progress', 'No change in accepted candidate, verification or release evidence for two hours. Research alone is insufficient progress; inspect blocked scopes and verification dependencies.'))
        active = [c for c in cards if c['status'] == 'running']
        recent_blocks = sorted([c for c in cards if c['status'] == 'blocked' and now - c['updatedAt']/1000 < 3600 and workflows.get(c['title'], {}).get('lifecycle', {}).get('state') == 'blocked'], key=lambda c:c['updatedAt'], reverse=True)
        for c in recent_blocks[:4]:
            comments = c.get('metadata', {}).get('comments', [])
            reason = workflows[c['title']].get('blocker') or (comments[-1]['body'] if comments else 'Inspect Workboard diagnostics.')
            fingerprint = hashlib.sha256((c['id']+reason).encode()).hexdigest()
            alerts.append((fingerprint, c['title'] + ': ' + reason[:430]))
        revision = status.get('control', {}).get('revision')
        if paused and revision != state.get('pauseRevision'):
            alerts.append(('paused:' + str(revision), 'Native board is paused by operator control. Inspect its recorded control revision and current maintenance before an explicit resume. Technical pauses do not require product approval.'))
        state['pauseRevision'] = revision if paused else None
        jobs = call('cron.list', {})['jobs']
        for j in jobs:
            if j.get('name', '').startswith(f'autocode:{BOARD}:'):
                s = j.get('state', {})
                if not j.get('enabled') and not status.get('control', {}).get('paused') and not status.get('control', {}).get('frozen'):
                    argv = j.get('payload', {}).get('argv', [])
                    if str(Path(REPOSITORY) / '.openclaw/native.json') in argv and 'native' in argv and any(a.endswith('/apps/dispatcher-cli/dist/index.js') for a in argv):
                        if not args.dry_run:
                            run([CLI, 'cron', 'enable', j['id'], '--timeout', '60000'])
                        print('Restored native schedule: ' + j['name'])
                        continue
                if not j.get('enabled') or s.get('consecutiveErrors', 0) >= 2:
                    alerts.append((j['id'], j['name'] + ': disabled or repeated scheduler failures.'))
        logs = subprocess.run(['journalctl', '--user', '-u', 'openclaw-gateway.service', '--since', '10 minutes ago', '--no-pager', '-n', '1500'], text=True, capture_output=True, timeout=15).stdout
        pid = subprocess.run(['systemctl', '--user', 'show', 'openclaw-gateway.service', '-p', 'MainPID', '--value'], text=True, capture_output=True, timeout=15).stdout.strip()
        if pid.isdigit() and pid != '0':
            logs = '\n'.join(line for line in logs.splitlines() if f'node[{pid}]' in line)
        if 'refresh_token_reused' in logs:
            alerts.append(('oauth-refresh', 'An OpenAI profile cannot refresh authentication. Owner sign-in is needed for that profile; working roles continue. Ask here to identify the affected role and provide the login flow.'))
        if logs.count('liveness warning:') >= 3 or logs.count('memory pressure: level=critical') >= 2:
            alerts.append(('gateway-pressure', 'Gateway reports sustained memory/CPU pressure. Inspect diagnostics and drain accepted work before a controlled restart; do not interrupt or replay active work.'))
        print(json.dumps({'running': len(active), 'recentBlocked': len(recent_blocks), 'alerts': len(alerts)}))
    except Exception as e:
        alerts.append(('control-plane-unreachable', 'Native control-plane probe failed: ' + str(e)[:350]))
    fresh = [(key, msg) for key, msg in alerts if now - state['alerts'].get(key, 0) >= 21600]
    if not fresh:
        save_state()
        return
    message = 'AutoCode needs attention.\n\n' + '\n\n'.join(msg for _, msg in fresh[:5])
    message += '\n\n' + alert_footer()
    if args.dry_run:
        print(message)
        return
    config = json.loads((Path.home() / '.openclaw' / 'openclaw.json').read_text())
    owner = next(h for h in config['plugins']['entries']['autocode']['config']['humanInput'] if h['boardId'] == BOARD)
    receipt = run([CLI, 'message', 'send', '--channel', 'telegram', '--account', owner.get('accountId','default'), '--target', owner['telegramTarget'], '--message', message[:3900], '--json'])
    (ROOT / 'last-delivery.json').write_text(json.dumps(receipt, indent=2))
    for key, _ in fresh[:5]:
        state['alerts'][key] = now
    save_state()
    print('Telegram blocker alert delivered')

if __name__ == '__main__':
    main()
