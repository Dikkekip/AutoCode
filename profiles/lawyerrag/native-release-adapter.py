#!/usr/bin/env python3
"""Trusted host release adapter. Configuration and credentials stay outside Git.

Preparation is repeatable and cannot deploy production. It records exact image
IDs and real isolated staging observations before returning a release identity.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def run(argv, *, timeout=120, env=None, log=None):
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env)
    if log:
        Path(log).write_text(p.stdout + p.stderr)
    if p.returncode:
        raise RuntimeError(f"{Path(argv[0]).name} failed with exit {p.returncode}; see scoped log")
    return p.stdout.strip()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    temp.chmod(0o600)
    temp.replace(path)


class Adapter:
    def __init__(self, config):
        self.c = config
        self.root = Path(config["stateDirectory"])
        self.root.mkdir(parents=True, exist_ok=True)
        self.source = Path(config["sourceRepository"])
        spec = importlib.util.spec_from_file_location("established_release", config["legacyAdapter"])
        self.legacy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.legacy)
        self.compose = ["docker", "compose", "-f", config["stagingCompose"]]

    def manifest(self, sha, tag):
        images = {}
        for service in ("backend", "reports-ui"):
            image = f"lawyerrag/{service}:{tag}"
            identity = json.loads(run(["docker", "image", "inspect", image]))[0]["Id"]
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", identity):
                raise RuntimeError("Image has no immutable identity")
            images[service] = {"reference": image, "id": identity}
        return {"version": 1, "revision": sha, "tag": tag, "images": images}

    def load(self, sha):
        m = json.loads((self.root / "manifests" / f"{sha}.json").read_text())
        if m["revision"] != sha or self.manifest(sha, m["tag"]) != m:
            raise RuntimeError("Release image identity changed")
        return m

    def assert_running_images(self, manifest):
        pods = self.legacy.kube("get", "pods")["items"]
        for app in ("backend", "backend-worker", "reports-ui"):
            selected = [p for p in pods if p["metadata"].get("labels", {}).get("app.kubernetes.io/name") == app
                        and not p["metadata"].get("deletionTimestamp")]
            if not selected:
                raise RuntimeError("Release workload is missing")
            image = manifest["images"]["backend" if app == "backend-worker" else app]["id"]
            for pod in selected:
                statuses = pod.get("status", {}).get("containerStatuses", [])
                expected_names = {app, "daprd"} if app != "reports-ui" else {app}
                if not expected_names.issubset({s["name"] for s in statuses}) or not all(s.get("ready") for s in statuses):
                    raise RuntimeError("Release workload or Dapr sidecar is not ready")
                if next(s for s in statuses if s["name"] == app).get("imageID") != image:
                    raise RuntimeError("Running image differs from staged immutable image")

    def bootstrap(self):
        live = self.legacy.live_revision()
        self.legacy.check(live["sha"])
        m = self.manifest(live["sha"], live["tag"])
        self.assert_running_images(m)
        if self.legacy.live_revision() != live:
            raise RuntimeError("Production changed during baseline observation")
        save(self.root / "manifests" / f'{live["sha"]}.json', m)
        return {"revision": live["sha"], "artifactSha256": digest(m)}

    def check(self, sha, expected):
        with Path(self.c["releaseLock"]).open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return self._check(sha, expected)

    def _check(self, sha, expected):
        m = self.load(sha)
        if digest(m) != expected:
            raise RuntimeError("Requested artifact differs from retained manifest")
        if self.legacy.live_revision()["sha"] != sha:
            raise RuntimeError("Target revision does not match requested release")
        self.legacy.assert_deployments({"sha":sha,"tag":m["tag"]})
        self.assert_running_images(m)
        healthy = True
        try:
            self.legacy.application_workflow()
        except Exception:
            healthy = False
        if self.legacy.live_revision()["sha"] != sha:
            raise RuntimeError("Target changed during observation")
        return {"targetId": self.c["targetId"], "deployedSha": sha,
                "artifactSha256": expected, "healthy": healthy, "workflowPassed": healthy,
                "observedAt": int(time.time() * 1000), "rolloutState": "settled"}

    def stage(self, manifest):
        compose_path = Path(self.c["stagingCompose"])
        definition = json.loads(compose_path.read_text())
        # Enforce isolation before applying any generated configuration.
        if any(not n.get("internal") for n in definition["networks"].values()):
            raise RuntimeError("Staging must use only internal networks")
        for service in definition["services"].values():
            if service.get("network_mode") or service.get("privileged"):
                raise RuntimeError("Staging cannot access host networking or privilege")
        for service in ("backend", "backend-worker", "reports-ui"):
            definition["services"][service]["image"] = manifest["images"]["backend" if service == "backend-worker" else service]["id"]
        save(compose_path, definition)
        # Restart disposable infrastructure after an operator stops staging.
        run([*self.compose, "up", "-d", "--wait", "--wait-timeout", "120",
             "postgres", "redis", "placement", "scheduler"], timeout=180)
        # Production also runs migrations separately from application startup.
        run([*self.compose, "stop", "backend", "backend-worker", "reports-ui"], timeout=60)
        run([*self.compose, "run", "--rm", "--no-deps", "--entrypoint", "python", "backend",
             "-m", "alembic", "-c", self.c["alembicPath"], "upgrade", "heads"],
            timeout=600, log=self.root / "staging-migrations.log")
        run([*self.compose, "up", "-d", "--wait", "--wait-timeout", "240"],
            timeout=300, log=self.root / "staging-start.log")
        probe_id = run([*self.compose, "exec", "-T", "backend", "python", "-m",
                        "lawyer_rag.workflows.deployment_probe", "start", "--timeout-seconds", "120"], timeout=180, log=self.root/"staging-workflow-start.log")
        if not re.fullmatch(r"dapr-probe-[a-f0-9]{32}", probe_id):
            raise RuntimeError("Staging durable workflow did not return its exact identity")
        try:
            run([*self.compose,"exec","-T","backend","python","-m",
                 "lawyer_rag.workflows.deployment_probe","finish","--instance-id",probe_id,
                 "--timeout-seconds","120"],timeout=180,log=self.root/"staging-workflow.log")
        finally:
            run([*self.compose,"exec","-T","backend","python","-m",
                 "lawyer_rag.workflows.deployment_probe","cleanup","--instance-id",probe_id],timeout=60)
        checks = []
        started = time.monotonic()
        while True:
            # Requests execute inside the internal network; no production secret,
            # production database, external model or public endpoint is used.
            probe = """import json,os,urllib.request
key=os.environ['LAWYER_RAG_API_KEY']
for path in ['/healthz','/readyz','/v1/matters']:
 req=urllib.request.Request('http://127.0.0.1:8000'+path,headers={'X-API-Key':key})
 with urllib.request.urlopen(req,timeout=20) as r:
  assert r.status==200
  value=json.load(r)
  if path=='/readyz': assert value.get('durable') is True and value.get('phase') == 'running', value
with urllib.request.urlopen('http://reports-ui/',timeout=20) as r:
 assert r.status==200 and b'id="root"' in r.read(2000000)
print('authenticated-matter-list, readiness, frontend-shell: passed')
"""
            run([*self.compose, "exec", "-T", "backend", "python", "-c", probe], timeout=60)
            for service in ("backend", "backend-worker", "reports-ui"):
                cid = run([*self.compose, "ps", "-q", service])
                info = json.loads(run(["docker", "inspect", cid]))[0]
                if info["Image"] != manifest["images"]["backend" if service == "backend-worker" else service]["id"] or not info["State"]["Running"]:
                    raise RuntimeError("Staging image identity changed")
            checks.append({"observedAt": int(time.time()*1000), "passed": True})
            if time.monotonic()-started >= self.c.get("stagingObservationSeconds",60):
                break
            time.sleep(10)
        result = {"revision":manifest["revision"],"artifactSha256":digest(manifest),"passed":True,
                  "windowSeconds":int(time.monotonic()-started),"checks":checks,
                  "coverage":["real database migrations","cross-service durable Dapr workflow","authenticated matter listing","API readiness","frontend shell","exact container identities"],
                  "limitations":["No external model calls or private legal data"]}
        save(self.root / "staging" / f'{manifest["revision"]}.json',result)
        return result

    def prepare(self, sha):
        path = self.root / "manifests" / f"{sha}.json"
        if path.exists():
            m = self.load(sha)
        else:
            self.legacy.git("fetch", "--no-tags", "origin", "main")
            self.legacy.git("merge-base", "--is-ancestor", sha, "origin/main")
            self.legacy.git("merge-base", "--is-ancestor", self.legacy.live_revision()["sha"], sha)
            if shutil.disk_usage(self.source).free < self.c.get("minimumBuildFreeGiB",30)*1024**3:
                raise RuntimeError("Release deferred: insufficient build storage")
            # Reserve a tag locally; publish only after this artifact passes staging.
            releases = json.loads(run(["gh","release","list","--repo",self.legacy.REPO,"--limit","100","--json","tagName,isDraft,isPrerelease"]))
            versions = [tuple(map(int,self.legacy.SEMVER.fullmatch(r["tagName"]).groups(default="0")))
                        for r in releases if not r["isDraft"] and not r["isPrerelease"] and self.legacy.SEMVER.fullmatch(r["tagName"])]
            v=max(versions); tag=f"v{v[0]}.{v[1]}.{v[2]+1}"
            if self.legacy.git("status","--porcelain","--untracked-files=no"):
                raise RuntimeError("Release checkout has local changes")
            self.legacy.git("checkout","--detach",sha)
            env=dict(os.environ,APP_VERSION=f"{tag}@{sha[:12]}",LAWYER_RAG_VERSION=tag,VITE_APP_VERSION=tag)
            run(["docker","compose","--env-file",str(self.source/".env"),"--project-name","lawyerrag_native_build",
                 "--file",str(self.source/"docker-compose.yml"),"build","--pull","backend","reports-ui"],
                timeout=5400,env=env,log=self.root/f"build-{sha}.log")
            for service in ("backend","reports-ui"):
                target=f"lawyerrag/{service}:{tag}"
                exists=subprocess.run(["docker","image","inspect",target],capture_output=True).returncode==0
                if exists: raise RuntimeError("Release tag already has an image; refusing overwrite")
                run(["docker","tag",f"lawyerrag_native_build-{service}:latest",target])
            m=self.manifest(sha,tag)
            save(path,m)
            save(self.legacy.ROOT/"release-plans"/f"{sha}.json",{"sha":sha,"tag":tag})
        self.stage(m)
        return {"targetId":self.c["targetId"],"revision":sha,"artifactSha256":digest(m),"staged":True}

    def deploy(self, sha, expected, rollback=False):
        m=self.load(sha)
        if digest(m)!=expected: raise RuntimeError("Deployment artifact mismatch")
        if not rollback:
            staged=json.loads((self.root/"staging"/f"{sha}.json").read_text())
            if not staged["passed"] or staged["artifactSha256"]!=expected:
                raise RuntimeError("Deployment lacks exact-artifact staging evidence")
            self.legacy.deploy(sha)
        else:
            with Path(self.c["releaseLock"]).open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                run([str(self.source/"scripts/k3s/deploy-release.sh"),m["tag"],sha,
                     m["images"]["backend"]["reference"],m["images"]["reports-ui"]["reference"]],
                    timeout=1800,log=self.root/f"rollback-{sha}.log")
                return self._check(sha,expected)
        return self.check(sha,expected)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--config",required=True)
    parser.add_argument("operation",choices=["bootstrap","stage-current","prepare","check","deploy","rollback"])
    a=parser.parse_args()
    adapter=Adapter(json.loads(Path(a.config).read_text()))
    with (adapter.root/"adapter.lock").open("a") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if a.operation=="bootstrap": result=adapter.bootstrap()
        elif a.operation=="stage-current":
            current=adapter.bootstrap(); result=adapter.stage(adapter.load(current["revision"]))
        else:
            sha=os.environ.get("AUTOCODE_SHA","")
            if not re.fullmatch(r"[a-f0-9]{40}",sha): raise RuntimeError("Exact AUTOCODE_SHA required")
            if os.environ.get("AUTOCODE_TARGET_ID")!=adapter.c["targetId"]: raise RuntimeError("Wrong target")
            if a.operation=="prepare": result=adapter.prepare(sha)
            elif a.operation=="check": result=adapter.check(sha,os.environ["AUTOCODE_ARTIFACT_SHA256"])
            else: result=adapter.deploy(sha,os.environ["AUTOCODE_ARTIFACT_SHA256"],a.operation=="rollback")
        print(json.dumps(result))

if __name__=="__main__":
    try: main()
    except Exception as error:
        import sys
        print(f"Autonomous release adapter: {type(error).__name__}: {error if isinstance(error,RuntimeError) else 'operation failed; inspect private logs'}",file=sys.stderr)
        sys.exit(1)
