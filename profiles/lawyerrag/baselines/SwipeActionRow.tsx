import {
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import { cn } from '@/utils/cn';

type SwipeAction = {
    label: string;
    icon: ReactNode;
    onAction: () => void;
    destructive?: boolean;
};

type PointerTrackingState = {
    active: boolean;
    axis: 'pending' | 'horizontal' | 'vertical';
    startX: number;
    startY: number;
    currentX: number;
    lastX: number;
    lastTime: number;
    velocityX: number;
};

type SwipeActionRowProps = {
    primaryAction: SwipeAction;
    secondaryAction: SwipeAction;
    children: ReactNode;
    className?: string;
    contentClassName?: string;
};

const AXIS_LOCK_THRESHOLD_PX = 8;
const MAX_TRANSLATE_X_PX = 148;
const SWIPE_TRIGGER_DISTANCE_PX = 54;
const PRIMARY_ACTION_DISTANCE_PX = 108;
const SWIPE_TRIGGER_VELOCITY_PX_PER_MS = 0.35;
const COARSE_POINTER_QUERY = '(pointer: coarse)';

function detectCoarsePointer(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false;
    }
    return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

export function SwipeActionRow({
    primaryAction,
    secondaryAction,
    children,
    className,
    contentClassName,
}: SwipeActionRowProps) {
    const contentRef = useRef<HTMLDivElement | null>(null);
    const rafRef = useRef<number | null>(null);
    const pendingOffsetRef = useRef(0);
    const suppressClickRef = useRef(false);
    const trackingRef = useRef<PointerTrackingState>({
        active: false,
        axis: 'pending',
        startX: 0,
        startY: 0,
        currentX: 0,
        lastX: 0,
        lastTime: 0,
        velocityX: 0,
    });
    const [isCoarsePointer, setIsCoarsePointer] = useState<boolean>(() => detectCoarsePointer());
    const [isDraggingHorizontally, setIsDraggingHorizontally] = useState(false);

    const scheduleTransform = useCallback((offset: number) => {
        pendingOffsetRef.current = offset;
        if (rafRef.current !== null) return;
        rafRef.current = window.requestAnimationFrame(() => {
            rafRef.current = null;
            if (!contentRef.current) return;
            contentRef.current.style.transform = `translateX(${pendingOffsetRef.current}px)`;
        });
    }, []);

    const resetTransform = useCallback(() => {
        scheduleTransform(0);
    }, [scheduleTransform]);

    const handlePointerMove = useCallback((event: PointerEvent) => {
        const tracking = trackingRef.current;
        if (!tracking.active) return;

        const deltaX = event.clientX - tracking.startX;
        const deltaY = event.clientY - tracking.startY;

        if (tracking.axis === 'pending') {
            if (
                Math.abs(deltaY) >= AXIS_LOCK_THRESHOLD_PX &&
                Math.abs(deltaY) > Math.abs(deltaX)
            ) {
                tracking.axis = 'vertical';
                tracking.active = false;
                resetTransform();
                return;
            }

            if (
                Math.abs(deltaX) >= AXIS_LOCK_THRESHOLD_PX &&
                Math.abs(deltaX) >= Math.abs(deltaY)
            ) {
                tracking.axis = 'horizontal';
                setIsDraggingHorizontally(true);
            }
        }

        if (tracking.axis !== 'horizontal') return;

        event.preventDefault();

        const now = performance.now();
        const elapsed = Math.max(1, now - tracking.lastTime);
        const velocityX = (event.clientX - tracking.lastX) / elapsed;

        tracking.currentX = event.clientX;
        tracking.velocityX = velocityX;
        tracking.lastX = event.clientX;
        tracking.lastTime = now;

        const clampedOffset = Math.max(-MAX_TRANSLATE_X_PX, Math.min(0, deltaX));
        scheduleTransform(clampedOffset);
    }, [resetTransform, scheduleTransform]);

    const finishSwipe = useCallback(() => {
        const tracking = trackingRef.current;
        if (tracking.axis !== 'horizontal') {
            setIsDraggingHorizontally(false);
            resetTransform();
            tracking.axis = 'pending';
            return;
        }

        const distanceX = Math.min(0, tracking.currentX - tracking.startX);
        const swipeDistance = Math.abs(distanceX);
        const leftVelocity = -tracking.velocityX;
        const shouldTrigger =
            swipeDistance >= SWIPE_TRIGGER_DISTANCE_PX &&
            leftVelocity >= SWIPE_TRIGGER_VELOCITY_PX_PER_MS;

        if (shouldTrigger) {
            suppressClickRef.current = true;
            if (swipeDistance >= PRIMARY_ACTION_DISTANCE_PX) {
                primaryAction.onAction();
            } else {
                secondaryAction.onAction();
            }
        }

        setIsDraggingHorizontally(false);
        resetTransform();
        tracking.axis = 'pending';
    }, [primaryAction, resetTransform, secondaryAction]);

    const stopTracking = useCallback(() => {
        const tracking = trackingRef.current;
        if (!tracking.active && tracking.axis !== 'horizontal') return;
        tracking.active = false;
        finishSwipe();
    }, [finishSwipe]);

    const handlePointerUp = useCallback(() => {
        stopTracking();
    }, [stopTracking]);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mediaQuery = window.matchMedia(COARSE_POINTER_QUERY);
        const updateValue = () => setIsCoarsePointer(mediaQuery.matches);
        updateValue();
        mediaQuery.addEventListener('change', updateValue);
        return () => {
            mediaQuery.removeEventListener('change', updateValue);
        };
    }, []);

    useEffect(() => {
        if (!isCoarsePointer) return;
        const onPointerMove = (event: PointerEvent) => handlePointerMove(event);
        const onPointerEnd = () => handlePointerUp();
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerEnd);
        window.addEventListener('pointercancel', onPointerEnd);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerEnd);
            window.removeEventListener('pointercancel', onPointerEnd);
        };
    }, [handlePointerMove, handlePointerUp, isCoarsePointer]);

    useEffect(() => {
        return () => {
            if (rafRef.current !== null) {
                window.cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, []);

    const handlePointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!isCoarsePointer) return;
        if (!event.isPrimary) return;
        if (event.pointerType === 'mouse') return;

        const now = performance.now();
        const tracking = trackingRef.current;
        tracking.active = true;
        tracking.axis = 'pending';
        tracking.startX = event.clientX;
        tracking.startY = event.clientY;
        tracking.currentX = event.clientX;
        tracking.lastX = event.clientX;
        tracking.lastTime = now;
        tracking.velocityX = 0;
        setIsDraggingHorizontally(false);
    };

    const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
    };

    return (
        <div
            className={cn('relative overflow-hidden', className)}
            onPointerDownCapture={handlePointerDownCapture}
            onClickCapture={handleClickCapture}
            style={isCoarsePointer ? { touchAction: 'pan-y' } : undefined}
        >
            {isCoarsePointer && (
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-stretch bg-muted/20">
                    {[secondaryAction, primaryAction].map((action, index) => (
                        <div
                            key={`${action.label}-${index}`}
                            className={cn(
                                'flex w-[78px] flex-col items-center justify-center gap-1 text-[10px] font-bold uppercase tracking-[0.14em]',
                                action.destructive
                                    ? 'bg-destructive/90 text-destructive-foreground'
                                    : index === 0
                                        ? 'border-l border-border/40 bg-secondary text-secondary-foreground'
                                        : 'bg-primary/90 text-primary-foreground',
                            )}
                        >
                            <span className="opacity-90">{action.icon}</span>
                            <span>{action.label}</span>
                        </div>
                    ))}
                </div>
            )}

            <div
                ref={contentRef}
                className={cn(
                    'relative z-10 will-change-transform',
                    isDraggingHorizontally
                        ? 'transition-none'
                        : 'transition-transform duration-200 ease-out',
                    contentClassName,
                )}
            >
                {children}
            </div>
        </div>
    );
}
