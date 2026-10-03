import type { WhatsAppMessage } from '@/lib/api';

import { TAG_COLORS } from '../constants';
import { detectOutgoing } from '../utils/detectOutgoing';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

interface SearchPanelProps {
    selectedChatId: string | null;
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    onSearch: () => void;
    searchResults: WhatsAppMessage[];
    searchCursor: number | null;
    searchLoadingMore: boolean;
    onLoadMore: () => void;
    onJumpToResult: (result: WhatsAppMessage) => void;
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedText(text: string, query: string) {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
        return text;
    }

    const pattern = new RegExp(`(${escapeRegExp(trimmedQuery)})`, 'ig');
    const parts = text.split(pattern);

    return parts.map((part, index) => {
        if (part.toLowerCase() === trimmedQuery.toLowerCase()) {
            return (
                <mark
                    key={`${part}-${index}`}
                    className="rounded bg-warning/20 px-0.5 text-foreground"
                >
                    {part}
                </mark>
            );
        }

        return <span key={`${part}-${index}`}>{part}</span>;
    });
}

export function SearchPanel({
    selectedChatId,
    searchQuery,
    onSearchQueryChange,
    onSearch,
    searchResults,
    searchCursor,
    searchLoadingMore,
    onLoadMore,
    onJumpToResult,
}: SearchPanelProps) {
    const searchDisabled = !selectedChatId || selectedChatId === '__ALL__';

    return (
        <section className="rounded-2xl border border-border/70 bg-background/75 backdrop-blur-sm">
            <div className="border-b border-border/60 px-4 py-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Support workspace
                </div>
                <h2 className="mt-1 text-lg font-semibold text-foreground">
                    Search within chat
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    Narrow the active conversation without pulling attention away from the thread.
                </p>
            </div>

            <div className="space-y-4 px-4 py-4">
                <div className="flex gap-2">
                    <Input
                        value={searchQuery}
                        onChange={(e) => onSearchQueryChange(e.target.value)}
                        placeholder={
                            selectedChatId === '__ALL__'
                                ? 'Search unavailable in browse mode'
                                : 'Search messages in the active chat'
                        }
                        className="flex-1 bg-background/70"
                        disabled={searchDisabled}
                    />
                    <Button
                        onClick={onSearch}
                        variant="primary"
                        size="sm"
                        className="shrink-0 px-4"
                        disabled={searchDisabled || !searchQuery.trim()}
                    >
                        Search
                    </Button>
                </div>

                {searchDisabled ? (
                    <div className="rounded-xl border border-border/60 bg-card/45 px-3 py-3 text-xs text-muted-foreground">
                        Select a specific chat to enable search. The date rail still supports chronology browsing across all chats.
                    </div>
                ) : null}

                {searchResults.length > 0 && (
                    <div className="rounded-xl border border-border/60 bg-card/35">
                        <div className="flex items-center justify-between border-b border-border/60 px-3 py-3">
                            <div>
                                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                                    Results
                                </div>
                                <div className="mt-1 text-sm font-semibold text-foreground">
                                    {searchResults.length} match{searchResults.length === 1 ? '' : 'es'}
                                </div>
                            </div>
                            <details className="group">
                                <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                                    Tag legend
                                </summary>
                                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                                    {Object.entries(TAG_COLORS).map(([key, colors]) => (
                                        <div
                                            key={key}
                                            className={`rounded-md border px-2.5 py-1.5 text-[11px] font-medium ${colors.bg} ${colors.text} ${colors.border}`}
                                            title={`Category: ${key.replace(/_/g, ' ')}`}
                                        >
                                            {key.replace(/_/g, ' ')}
                                        </div>
                                    ))}
                                </div>
                            </details>
                        </div>

                        <div className="max-h-[26rem] space-y-2 overflow-y-auto p-3 custom-scrollbar">
                            {searchResults.map((result) => {
                                const isResultOutgoing = detectOutgoing(result);
                                return (
                                    <button
                                        key={result.message_id}
                                        onClick={() => onJumpToResult(result)}
                                        aria-label={`Jump to message from ${result.sender || 'Unknown'}, ${result.text ? result.text.substring(0, 50) + '...' : 'No content'}`}
                                        className={`w-full rounded-xl border px-3 py-3 text-left text-xs transition-colors ${
                                            isResultOutgoing
                                                ? 'border-accent/35 bg-secondary/35 hover:border-accent/50'
                                                : 'border-border/60 bg-background/75 hover:border-border'
                                        }`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <div
                                                className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${
                                                    isResultOutgoing
                                                        ? 'bg-primary text-primary-foreground'
                                                        : 'bg-muted text-foreground'
                                                }`}
                                            >
                                                {result.sender?.charAt(0)?.toUpperCase() || '?'}
                                            </div>
                                            <span className="font-semibold text-foreground">
                                                {result.sender || 'Unknown'}
                                            </span>
                                            <span className="text-muted-foreground/70">
                                                {result.journal_date || 'Unknown date'}
                                            </span>
                                            <span className="font-mono text-[10px] text-muted-foreground">
                                                {result.timestamp || ''}
                                            </span>
                                        </div>
                                        <div className="mt-2 line-clamp-3 pl-8 text-sm leading-relaxed text-muted-foreground">
                                            {renderHighlightedText(result.text, searchQuery)}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        {searchCursor !== null && (
                            <div className="border-t border-border/60 p-3">
                                <Button
                                    onClick={onLoadMore}
                                    variant="ghost"
                                    size="sm"
                                    className="w-full"
                                    disabled={searchLoadingMore}
                                >
                                    {searchLoadingMore
                                        ? 'Loading results...'
                                        : 'Load more results'}
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
}
