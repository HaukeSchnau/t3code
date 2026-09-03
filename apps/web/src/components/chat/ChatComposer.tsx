import type {
  ApprovalRequestId,
  AssistantCitation,
  ChatFileAttachment,
  EnvironmentId,
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  RuntimeMode,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import {
  isProviderSendTurnSupportedImageMimeType,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  clampCollapsedComposerCursor,
  type ComposerSubmissionIntent,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  composerSubmissionIntentForEnter,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  formatAssistantCitationForComposer,
  replaceTextRange,
} from "../../composer-logic";
import {
  deriveComposerSendState,
  getAntigravitySendBlockReason,
  readFileAsDataUrl,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
} from "../ChatView.logic";
import {
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
} from "./composerMentionDrag";
import {
  composerFloatingLayerProps,
  isInsideComposerFloatingLayer,
  isInsideRestingComposerControlScope,
} from "./composerEventScope";
import {
  type ComposerImageAttachment,
  type DraftId,
  type PersistedComposerImageAttachment,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import {
  MAX_STASH_ENTRIES,
  partitionStashAttachments,
  usePromptStashStore,
  type PromptStashEntry,
} from "../../promptStashStore";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashMenu } from "./ComposerStashMenu";
import {
  ComposerTasksBadge,
  ComposerTasksContent,
  ComposerTasksDrawer,
  type ComposerTaskStep,
  type ComposerTasksProgress,
} from "./ComposerTasksBadge";
import { ComposerActivityRow } from "./ComposerActivityStatus";
import { ComposerBanner } from "./ComposerBanner";
import {
  ComposerBannerStack,
  type ComposerBannerStackContent,
  type ComposerBannerStackItem,
} from "./ComposerBannerStack";
import { ComposerSurface } from "./ComposerSurface";
import type { ThreadSyncPhase } from "../../threadSync";
import {
  compressImageForStash,
  isHeicImageFile,
  prepareImageForAttachment,
} from "../../lib/imageCompression";
import {
  releaseAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import {
  attachmentUploadBlockReason,
  formatAttachmentUploadProgress,
} from "../../lib/attachmentUploadState";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
} from "../../lib/terminalContext";
import { useComposerPathSearch } from "../../lib/composerPathSearchState";
import { type ElementContextDraft } from "../../lib/elementContext";
import { ComposerPendingElementContexts } from "./ComposerPendingElementContexts";
import { ComposerPendingReviewComments } from "./ComposerPendingReviewComments";
import { ComposerPreviewAnnotationCards } from "./ComposerPreviewAnnotationCards";
import {
  COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX,
  COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
  getRestingComposerImagePreviewCounts,
  resolveRestingComposerControlsLayout,
  shouldAnimateComposerRestingTransition,
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
  shouldUseRestingComposerLayout,
} from "../composerFooterLayout";
import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";
import { observeResponsiveBreakpointFade, usePanelAnimationSettings } from "../../panelAnimations";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import {
  ComposerControl,
  ComposerControlIcon,
  ComposerControlSeparator,
  ComposerSelectControl,
} from "./ComposerControl";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import {
  cycleComposerReasoningEffort,
  getComposerPromptInjectionState,
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { resolveContextWindowModelDisplayName } from "./ContextWindowMeter.logic";
import {
  attachVideoThumbnail,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { UsageLimitsMeter } from "./UsageLimitsMeter";
import { basenameOfPath } from "../../pierre-icons";
import { cn, randomUUID } from "~/lib/utils";
import {
  getComposerPromptLengthValidationMessage,
  getComposerSubmissionValidationMessage,
  submitComposerDraft,
} from "./composerSubmission";
import { ComposerPromptLengthValidation } from "./ComposerPromptLengthValidation";
import {
  createComposerScrollGestureState,
  recordComposerScrollGestureEvent,
  resetComposerScrollGesture,
  suppressActiveComposerScrollGesture,
} from "./composerScrollGesture";
import { prepareVideoFirstFrame } from "../../lib/videoFirstFrame";

function ComposerVideoThumbnail({ file }: { file: File }) {
  const setVideo = useCallback(
    (video: HTMLVideoElement | null) => {
      if (!video) return;
      return attachVideoThumbnail(video, file);
    },
    [file],
  );

  return (
    <video
      ref={setVideo}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      onLoadedMetadata={(event) => prepareVideoFirstFrame(event.currentTarget)}
      className="pointer-events-none absolute inset-0 size-full object-cover"
    />
  );
}

type ComposerCommandMenuPosition = {
  bottom: number;
  left: number;
  maxHeight: number;
  width: number;
};

const COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX = 24;
const COMPOSER_SCROLL_GESTURE_RESET_MS = 120;
const COMPOSER_RESTING_TRANSITION_DURATION_MS = 280;
const COMPOSER_RESTING_TRANSITION_CLEANUP_BUFFER_MS = 50;
const COMPOSER_RESTING_TRANSITION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const COMPOSER_RESTING_CONTROLS_ARRIVAL_DRIFT_PX = 4;

function useComposerRestingTransition(
  isCollapsed: boolean,
  restingControlsRef: React.RefObject<HTMLDivElement | null>,
  onOverlayHeightChange: (height: number) => void,
) {
  const elementRef = useRef<HTMLDivElement>(null);
  const isCollapsedRef = useRef(isCollapsed);
  const previousCollapsedRef = useRef(isCollapsed);
  const previousHeightRef = useRef<number | null>(null);
  const previousContentOffsetsRef = useRef<{
    promptFromTop: number | null;
    promptHeight: number | null;
    actionFromBottom: number | null;
  }>({ promptFromTop: null, promptHeight: null, actionFromBottom: null });
  const animationRef = useRef<Animation | null>(null);
  const animationTargetHeightRef = useRef<number | null>(null);
  const contentAnimationsRef = useRef<Animation[]>([]);
  const stateChangeAnimationsRef = useRef<Animation[]>([]);
  const pinnedOverlayRef = useRef<HTMLElement | null>(null);
  const transitionCleanupTimeoutRef = useRef<number | null>(null);
  const transitionLayoutRequestRef = useRef(0);
  const hasCompletedInitialLayoutRef = useRef(false);

  const clearOverlayPin = useCallback(() => {
    // The overlay belongs to the chat view and outlives this composer, so it
    // is remembered from pin time rather than re-resolved through a ref that
    // React may already have detached during unmount.
    const overlay = pinnedOverlayRef.current;
    pinnedOverlayRef.current = null;
    overlay?.style.removeProperty("height");
    overlay?.style.removeProperty("display");
    overlay?.style.removeProperty("flex-direction");
    overlay?.style.removeProperty("justify-content");
  }, []);

  const clearTransitionStyles = useCallback(() => {
    const element = elementRef.current;
    const footer = element?.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
    element?.style.removeProperty("overflow");
    element
      ?.querySelector<HTMLElement>('[data-chat-composer-surface="true"]')
      ?.style.removeProperty("height");
    footer?.style.removeProperty("position");
    footer?.style.removeProperty("top");
    footer?.style.removeProperty("bottom");
    footer?.style.removeProperty("left");
    footer?.style.removeProperty("right");
    footer?.style.removeProperty("height");
    clearOverlayPin();
  }, [clearOverlayPin]);

  isCollapsedRef.current = isCollapsed;

  const transitionToCurrentGeometry = useCallback(
    (stateChanged: boolean) => {
      const element = elementRef.current;
      const surface = element?.querySelector<HTMLElement>('[data-chat-composer-surface="true"]');
      if (!element || !surface) return;

      const nextIsCollapsed = isCollapsedRef.current;

      const visibleTransitionElement = (selector: string) =>
        Array.from(element.querySelectorAll<HTMLElement>(selector)).find(
          (candidate) => candidate.getClientRects().length > 0,
        ) ?? null;
      const prompt = visibleTransitionElement(
        '[data-testid="composer-editor"], [data-chat-composer-transition-prompt="true"]',
      );
      const action = visibleTransitionElement('[data-chat-composer-transition-actions="true"]');
      const footer = element.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
      const interruptedAnimation = animationRef.current;
      const interruptedPromptTop = interruptedAnimation
        ? (prompt?.getBoundingClientRect().top ?? null)
        : null;
      const interruptedActionTop = interruptedAnimation
        ? (action?.getBoundingClientRect().top ?? null)
        : null;
      const interruptedHeight = interruptedAnimation
        ? element.getBoundingClientRect().height
        : null;
      const interruptedTargetHeight = animationTargetHeightRef.current;
      const interruptedCurrentTime =
        typeof interruptedAnimation?.currentTime === "number"
          ? interruptedAnimation.currentTime
          : null;
      const interruptedDuration = interruptedAnimation?.effect?.getComputedTiming().duration;
      if (transitionCleanupTimeoutRef.current !== null) {
        window.clearTimeout(transitionCleanupTimeoutRef.current);
        transitionCleanupTimeoutRef.current = null;
      }
      interruptedAnimation?.cancel();
      animationRef.current = null;
      for (const animation of contentAnimationsRef.current) animation.cancel();
      contentAnimationsRef.current = [];
      // The reveal and fade animations keep their own schedule across the
      // body-resize re-entries that retarget the geometry mid-flight (every
      // transition with a draft triggers one); cancelling them there would
      // pop their subjects to full visibility at the start of the tween.
      if (stateChanged) {
        for (const animation of stateChangeAnimationsRef.current) animation.cancel();
        stateChangeAnimationsRef.current = [];
      }
      clearTransitionStyles();

      const nextRect = element.getBoundingClientRect();
      const nextHeight = nextRect.height;
      const nextPromptRect = prompt?.getBoundingClientRect() ?? null;
      const nextPromptTop = nextPromptRect?.top ?? null;
      const nextActionTop = action?.getBoundingClientRect().top ?? null;
      const previousHeight = interruptedHeight ?? previousHeightRef.current;
      const targetChanged =
        interruptedTargetHeight === null || Math.abs(interruptedTargetHeight - nextHeight) >= 0.5;
      const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const shouldAnimate = shouldAnimateComposerRestingTransition({
        hasCompletedInitialLayout: hasCompletedInitialLayoutRef.current,
        stateChanged,
        hasInterruptedAnimation: interruptedHeight !== null,
      });

      if (
        shouldAnimate &&
        !prefersReducedMotion &&
        previousHeight !== null &&
        Math.abs(previousHeight - nextHeight) >= 0.5
      ) {
        const remainingDuration =
          typeof interruptedDuration === "number" && interruptedCurrentTime !== null
            ? Math.max(1, interruptedDuration - interruptedCurrentTime)
            : COMPOSER_RESTING_TRANSITION_DURATION_MS;
        const duration =
          interruptedHeight !== null && !targetChanged
            ? remainingDuration
            : COMPOSER_RESTING_TRANSITION_DURATION_MS;
        element.style.overflow = "clip";
        surface.style.height = "100%";

        // The chat view resize-observes the overlay to place the timeline
        // inset, the scroll-to-end pill, and the mini player. Pinning the
        // overlay at the destination height turns that feedback into one
        // update instead of a ChatView re-render on every animation frame;
        // bottom alignment keeps the animating surface glued to the overlay's
        // stable bottom edge. The pin lasts only for the tween so later
        // attachment, thread, font, and viewport changes remain natural.
        const overlay = element.closest<HTMLElement>('[data-chat-composer-overlay="true"]');
        let pinnedOverlayHeight: number | null = null;
        if (overlay) {
          pinnedOverlayHeight = overlay.getBoundingClientRect().height;
          overlay.style.height = `${String(pinnedOverlayHeight)}px`;
          overlay.style.display = "flex";
          overlay.style.flexDirection = "column";
          overlay.style.justifyContent = "flex-end";
          pinnedOverlayRef.current = overlay;
        }

        // Keep the footer attached to the stable bottom edge while the outer
        // height changes. Its resting absolute layout otherwise spans the old
        // height on collapse, while its expanded flow layout falls below the
        // clipped surface on expansion.
        if (footer) {
          footer.style.position = "absolute";
          footer.style.top = "auto";
          footer.style.bottom = "1px";
          footer.style.height = "3rem";
          if (nextIsCollapsed) {
            footer.style.left = "auto";
            footer.style.right = "1px";
          } else {
            footer.style.left = "1px";
            footer.style.right = "1px";
          }
        }

        const animation = element.animate(
          [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
          {
            duration,
            easing: COMPOSER_RESTING_TRANSITION_EASING,
          },
        );
        animationRef.current = animation;
        animationTargetHeightRef.current = nextHeight;
        // Publish the destination overlay geometry in the same layout pass;
        // ResizeObserver remains the fallback for non-transition changes.
        if (pinnedOverlayHeight !== null) {
          onOverlayHeightChange(pinnedOverlayHeight);
        }

        const animatedRect = element.getBoundingClientRect();
        const previousPromptTop =
          interruptedPromptTop ??
          (previousContentOffsetsRef.current.promptFromTop === null
            ? null
            : animatedRect.top + previousContentOffsetsRef.current.promptFromTop);
        const previousActionTop =
          interruptedActionTop ??
          (previousContentOffsetsRef.current.actionFromBottom === null
            ? null
            : animatedRect.bottom - previousContentOffsetsRef.current.actionFromBottom);
        const contentAnimations: Animation[] = [];
        const animateContentPosition = (
          content: HTMLElement | null,
          previousTop: number | null,
        ) => {
          if (!content || previousTop === null) return;
          const offset = previousTop - content.getBoundingClientRect().top;
          if (Math.abs(offset) < 0.5) return;
          contentAnimations.push(
            content.animate(
              [{ transform: `translateY(${String(offset)}px)` }, { transform: "none" }],
              {
                duration,
                easing: COMPOSER_RESTING_TRANSITION_EASING,
              },
            ),
          );
        };
        animateContentPosition(prompt, previousPromptTop);
        animateContentPosition(action, previousActionTop);
        contentAnimationsRef.current = contentAnimations;

        if (stateChanged) {
          const stateChangeAnimations: Animation[] = [];

          // A prompt that gains lines on expansion would otherwise slide up
          // from under the footer band as one block. Opening a bottom clip in
          // step with the tween instead unfurls the extra lines beneath the
          // rising first line, so no text crosses the returning controls.
          const previousPromptHeight = previousContentOffsetsRef.current.promptHeight;
          if (
            !nextIsCollapsed &&
            prompt &&
            nextPromptRect &&
            previousPromptHeight !== null &&
            nextPromptRect.height - previousPromptHeight >= 0.5
          ) {
            const hiddenHeight = nextPromptRect.height - previousPromptHeight;
            stateChangeAnimations.push(
              prompt.animate(
                [
                  { clipPath: `inset(0 0 ${String(hiddenHeight)}px 0)` },
                  { clipPath: "inset(0 0 0 0)" },
                ],
                {
                  duration,
                  easing: COMPOSER_RESTING_TRANSITION_EASING,
                },
              ),
            );
          }

          // The footer controls teleport between the composer footer and the
          // context strip below it in a single commit. Fading the arriving
          // cluster in along its direction of travel reads as one continuous
          // move instead of a pop. Collapsing controls land in empty strip
          // space and can appear immediately, but expanding controls return
          // to the bottom row the prompt still occupies while the surface is
          // short, so they stay hidden through the first half of the tween
          // and fade in once the geometry has mostly settled.
          const arrivingControls = nextIsCollapsed
            ? restingControlsRef.current
            : element.querySelector<HTMLElement>('[data-chat-composer-controls="left"]');
          if (arrivingControls) {
            const drift = nextIsCollapsed
              ? -COMPOSER_RESTING_CONTROLS_ARRIVAL_DRIFT_PX
              : COMPOSER_RESTING_CONTROLS_ARRIVAL_DRIFT_PX;
            stateChangeAnimations.push(
              arrivingControls.animate(
                [
                  { opacity: 0, transform: `translateY(${String(drift)}px)` },
                  { opacity: 1, transform: "none" },
                ],
                {
                  duration: nextIsCollapsed ? duration : duration / 2,
                  delay: nextIsCollapsed ? 0 : duration / 2,
                  fill: "backwards",
                  easing: COMPOSER_RESTING_TRANSITION_EASING,
                },
              ),
            );
          }

          const arrivingImagePreviews = nextIsCollapsed
            ? Array.from(
                element.querySelectorAll<HTMLElement>('[data-chat-composer-resting-images="true"]'),
              )
            : Array.from(
                element.querySelectorAll<HTMLElement>('[data-chat-composer-expanded-image="true"]'),
              );
          for (const imagePreview of arrivingImagePreviews) {
            stateChangeAnimations.push(
              imagePreview.animate([{ opacity: 0 }, { opacity: 1 }], {
                duration: nextIsCollapsed ? duration : duration / 2,
                delay: nextIsCollapsed ? 0 : duration / 2,
                fill: "backwards",
                easing: COMPOSER_RESTING_TRANSITION_EASING,
              }),
            );
          }
          stateChangeAnimationsRef.current = stateChangeAnimations;
        }

        const finishTransition = (cancelAnimations: boolean) => {
          if (animationRef.current !== animation) return;
          if (transitionCleanupTimeoutRef.current !== null) {
            window.clearTimeout(transitionCleanupTimeoutRef.current);
            transitionCleanupTimeoutRef.current = null;
          }
          if (cancelAnimations) {
            animation.cancel();
            for (const contentAnimation of contentAnimationsRef.current) {
              contentAnimation.cancel();
            }
            for (const stateChangeAnimation of stateChangeAnimationsRef.current) {
              stateChangeAnimation.cancel();
            }
          }
          animationRef.current = null;
          animationTargetHeightRef.current = null;
          contentAnimationsRef.current = [];
          stateChangeAnimationsRef.current = [];
          clearTransitionStyles();
        };
        void animation.finished.catch(() => undefined).then(() => finishTransition(false));
        // A suspended document timeline can leave `finished` pending while
        // these measurement styles remain active. Wall-clock cleanup makes
        // the natural layout the eventual source of truth in that case.
        transitionCleanupTimeoutRef.current = window.setTimeout(
          () => finishTransition(true),
          duration + COMPOSER_RESTING_TRANSITION_CLEANUP_BUFFER_MS,
        );
      } else {
        animationTargetHeightRef.current = null;
      }

      previousCollapsedRef.current = nextIsCollapsed;
      previousHeightRef.current = nextHeight;
      previousContentOffsetsRef.current = {
        promptFromTop: nextPromptTop === null ? null : nextPromptTop - nextRect.top,
        promptHeight: nextPromptRect?.height ?? null,
        actionFromBottom: nextActionTop === null ? null : nextRect.bottom - nextActionTop,
      };
    },
    [clearTransitionStyles, onOverlayHeightChange, restingControlsRef],
  );

  useLayoutEffect(() => {
    const requestId = transitionLayoutRequestRef.current + 1;
    transitionLayoutRequestRef.current = requestId;
    const stateChanged = previousCollapsedRef.current !== isCollapsed;
    // A non-Git context strip enters or leaves flow through ChatView state in
    // an earlier layout effect. Let React flush that parent update before the
    // FLIP reads its destination geometry, while still running before paint.
    queueMicrotask(() => {
      if (transitionLayoutRequestRef.current !== requestId) return;
      transitionToCurrentGeometry(stateChanged);
    });
    return () => {
      if (transitionLayoutRequestRef.current === requestId) {
        transitionLayoutRequestRef.current += 1;
      }
    };
  }, [isCollapsed, transitionToCurrentGeometry]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const body = element.querySelector<HTMLElement>('[data-chat-composer-body="true"]');
    const observer = new ResizeObserver((entries) => {
      if (animationRef.current) {
        if (body && entries.some((entry) => entry.target === body)) {
          transitionToCurrentGeometry(false);
        }
        return;
      }
      const elementRect = element.getBoundingClientRect();
      const visibleTransitionElement = (selector: string) =>
        Array.from(element.querySelectorAll<HTMLElement>(selector)).find(
          (candidate) => candidate.getClientRects().length > 0,
        ) ?? null;
      const promptRect = visibleTransitionElement(
        '[data-testid="composer-editor"], [data-chat-composer-transition-prompt="true"]',
      )?.getBoundingClientRect();
      const actionTop = visibleTransitionElement(
        '[data-chat-composer-transition-actions="true"]',
      )?.getBoundingClientRect().top;
      previousHeightRef.current = elementRect.height;
      previousContentOffsetsRef.current = {
        promptFromTop: promptRect === undefined ? null : promptRect.top - elementRect.top,
        promptHeight: promptRect?.height ?? null,
        actionFromBottom: actionTop === undefined ? null : elementRect.bottom - actionTop,
      };
    });
    observer.observe(element);
    if (body) observer.observe(body);
    return () => observer.disconnect();
  }, [transitionToCurrentGeometry]);

  useEffect(() => {
    // Host discovery and width measurement settle through layout updates on
    // mount. Treat that bootstrap as initial geometry so an existing thread
    // paints at rest instead of visibly collapsing from the expanded height.
    hasCompletedInitialLayoutRef.current = true;
    return () => {
      if (transitionCleanupTimeoutRef.current !== null) {
        window.clearTimeout(transitionCleanupTimeoutRef.current);
        transitionCleanupTimeoutRef.current = null;
      }
      animationRef.current?.cancel();
      animationRef.current = null;
      animationTargetHeightRef.current = null;
      for (const animation of contentAnimationsRef.current) animation.cancel();
      contentAnimationsRef.current = [];
      for (const animation of stateChangeAnimationsRef.current) animation.cancel();
      stateChangeAnimationsRef.current = [];
      clearTransitionStyles();
    };
  }, [clearTransitionStyles]);

  return elementRef;
}

const NOOP = () => {};
const NO_TIMELINE_SCROLLABLE_NODE = () => null;
const TIMELINE_AT_LOGICAL_END = () => true;

function composerCommandMenuPositionsEqual(
  a: ComposerCommandMenuPosition,
  b: ComposerCommandMenuPosition,
): boolean {
  return (
    a.bottom === b.bottom && a.left === b.left && a.maxHeight === b.maxHeight && a.width === b.width
  );
}

function ComposerCommandMenuLayer(props: { anchor: HTMLElement | null; children: ReactNode }) {
  const [position, setPosition] = useState<ComposerCommandMenuPosition | null>(null);

  useLayoutEffect(() => {
    const anchor = props.anchor;
    if (!anchor) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      const next = {
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
        maxHeight: Math.max(96, rect.top - 24),
        width: rect.width,
      };
      setPosition((current) =>
        current && composerCommandMenuPositionsEqual(current, next) ? current : next,
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    if (observer) {
      // The composer is centered and capped at a max width, so opening a side
      // panel slides it sideways without ever resizing it. Watching the anchor
      // alone would leave the menu behind; the ancestors are what shrink, and
      // they resize on every frame of the panel animation.
      observer.observe(anchor);
      for (let element = anchor.parentElement; element; element = element.parentElement) {
        observer.observe(element);
      }
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [props.anchor]);

  if (!position) return null;

  return createPortal(
    <div
      className="pointer-events-auto fixed z-[70]"
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  BotIcon,
  CircleAlertIcon,
  FileIcon,
  PencilRulerIcon,
  type LucideIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  PlayIcon,
  RotateCcwIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { proposedPlanTitle } from "../../proposedPlan";
import { hasProviderSetup } from "./ProviderStatusBanner";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import type { SessionPhase, Thread } from "../../types";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import {
  formatProviderSkillDisplayName,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import {
  deriveLatestUsageLimitsSnapshotForSources,
  type UsageLimitsActivitySource,
  type UsageLimitsSnapshot,
} from "../../lib/usageLimits";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import type { ReviewCommentContext } from "../../reviewCommentContext";

const WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS = 10_000;

const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

export function shouldDisableComposerPromptEditor(input: {
  readonly isConnecting: boolean;
  readonly isComposerApprovalState: boolean;
  readonly isEnvironmentUnavailable: boolean;
}): boolean {
  return input.isConnecting || input.isComposerApprovalState;
}

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

function useRestingComposerControlsLayout(host: HTMLDivElement | null) {
  const controlsRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  const [layout, setLayout] = useState({ hiddenCount: 0, visible: true });

  const measure = useCallback(() => {
    const currentHost = hostRef.current;
    const controls = controlsRef.current;
    // The controls only mount while the composer rests, so the expanded
    // composer pays no layout reads here despite the every-render effect.
    if (currentHost === null || !controls) return;

    const measurement = measureRestingComposerControls(controls);
    if (!measurement) return;
    const hostWidth = currentHost.clientWidth;

    setLayout((current) => {
      const next = resolveRestingComposerControlsLayout({ ...measurement, hostWidth });
      return next.hiddenCount === current.hiddenCount && next.visible === current.visible
        ? current
        : next;
    });
  }, []);

  useLayoutEffect(measure);
  useEffect(() => {
    if (!host) return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [host, measure]);

  return { controlsRef, hiddenBlockCount: layout.hiddenCount, controlsVisible: layout.visible };
}

const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  size?: "sm" | "xs";
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const size = props.size ?? "sm";
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode — click to return to normal build mode"
      : "Default mode — click to enter plan mode";

  const interactionModeToggle = props.showInteractionModeToggle ? (
    <>
      <ComposerControlSeparator size={size} />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size={size}
              className={cn(
                "shrink-0 whitespace-nowrap",
                props.interactionMode === "plan"
                  ? "bg-accent text-accent-foreground hover:bg-accent/80"
                  : size === "xs"
                    ? undefined
                    : "text-secondary-label hover:text-foreground",
              )}
              type="button"
              onClick={props.onToggleInteractionMode}
              aria-label={interactionModeTooltip}
            />
          }
        >
          {props.interactionMode === "plan" ? (
            <ComposerControlIcon
              icon={PencilRulerIcon}
              size={size}
              className="text-current opacity-100"
            />
          ) : (
            <ComposerControlIcon
              icon={BotIcon}
              size={size}
              opticalSize={size === "xs" ? "default" : "large"}
            />
          )}
          <span className="sr-only sm:not-sr-only">
            {props.interactionMode === "plan" ? "Plan" : "Build"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
      </Tooltip>
    </>
  ) : null;

  return (
    <>
      <ComposerControlSeparator size={size} />

      <Tooltip>
        <Select
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value!)}
        >
          <TooltipTrigger
            render={
              <ComposerSelectControl
                size={size}
                className={size === "xs" ? undefined : "font-medium"}
                aria-label="Runtime mode"
              />
            }
          >
            <ComposerControlIcon icon={RuntimeModeIcon} size={size} />
            <SelectValue>{runtimeModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
            {runtimeModeOptions.map((mode) => {
              const option = runtimeModeConfig[mode];
              const OptionIcon = option.icon;
              return (
                <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {option.description}
                      </span>
                    </div>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{runtimeModeOption.description}</TooltipPopup>
      </Tooltip>

      {interactionModeToggle}
    </>
  );
});

export function ComposerUsageLimitsMeterSlot(props: {
  compact: boolean;
  selectedProvider: ProviderDriverKind;
  selectedModel?: string | null;
  activeUsageLimits: UsageLimitsSnapshot | null;
}) {
  const selectedModelSeparator = props.selectedModel?.indexOf("/") ?? -1;
  const selectedOpenCodeProvider =
    selectedModelSeparator > 0 ? props.selectedModel?.slice(0, selectedModelSeparator) : null;
  const selectedOpenCodeModel =
    selectedModelSeparator > 0 ? props.selectedModel?.slice(selectedModelSeparator + 1) : null;
  const supportsOpenCodeGlmUsageLimits =
    props.selectedProvider === ProviderDriverKind.make("opencode") &&
    selectedOpenCodeModel?.toLowerCase().startsWith("glm-") === true &&
    selectedOpenCodeProvider === props.activeUsageLimits?.limitId;
  const supportsUsageLimits =
    props.selectedProvider === ProviderDriverKind.make("codex") ||
    props.selectedProvider === ProviderDriverKind.make("claudeAgent") ||
    supportsOpenCodeGlmUsageLimits;
  if (!supportsUsageLimits || !props.activeUsageLimits) {
    return null;
  }

  return <UsageLimitsMeter usageLimits={props.activeUsageLimits} compact={props.compact} />;
}

const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  selectedProvider: ProviderDriverKind;
  selectedModel: string;
  activeContextWindow: ContextWindowSnapshot | null;
  activeUsageLimits: UsageLimitsSnapshot | null;
  activeThreadModelDisplayName: string | null;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  canPauseTurn: boolean;
  canResumeInterruptedTurn: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  showSendWhileRunning?: boolean;
  showSecondaryStatus: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onResumeInterruptedTurn: () => void;
  onImplementPlanInNewThread: () => void;
  onCompactContext?: (() => void) | undefined;
  compactDisabled: boolean;
  compactDisabledReason: string | null;
}) {
  return (
    <>
      {props.showSecondaryStatus && props.activeContextWindow ? (
        <ContextWindowMeter
          usage={props.activeContextWindow}
          modelDisplayName={props.activeThreadModelDisplayName}
          onCompact={props.onCompactContext}
          compactDisabled={props.compactDisabled}
          compactDisabledReason={props.compactDisabledReason}
        />
      ) : null}
      <ComposerUsageLimitsMeterSlot
        compact={props.compact}
        selectedProvider={props.selectedProvider}
        selectedModel={props.selectedModel}
        activeUsageLimits={props.activeUsageLimits}
      />
      {props.isPreparingWorktree ? (
        <span className="text-secondary-label text-xs">Preparing worktree...</span>
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        canPauseTurn={props.canPauseTurn}
        canResumeInterruptedTurn={props.canResumeInterruptedTurn}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        sendDisabledReason={props.sendDisabledReason}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        showSendWhileRunning={props.showSendWhileRunning ?? false}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onResumeInterruptedTurn={props.onResumeInterruptedTurn}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
      />
    </>
  );
});

// --------------------------------------------------------------------------
// Handle exposed to ChatView
// --------------------------------------------------------------------------

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  /** Undo only a scroll-triggered collapse when the timeline returns to its live edge. */
  restoreAfterTimelineReachedEnd: () => void;
  addDroppedFiles: (files: File[]) => void;
  insertTextAtEnd: (text: string, options?: { ensureLeadingBoundary?: boolean }) => boolean;
  citeAssistantText: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  openModelPicker: () => void;
  toggleModelPicker: () => void;
  cycleReasoningEffort: () => void;
  isModelPickerOpen: () => boolean;
  compactContext: () => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
  /** Reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend). */
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  /** Insert a terminal context from the terminal drawer. */
  addTerminalContext: (selection: TerminalContextSelection) => void;
  /** Get the current prompt/effort/model state for use in send. */
  getSendContext: () => {
    prompt: string;
    images: ComposerImageAttachment[];
    terminalContexts: TerminalContextDraft[];
    elementContexts: ElementContextDraft[];
    previewAnnotations: PreviewAnnotationPayload[];
    reviewComments: ReviewCommentContext[];
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    providerAvailable: boolean;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
    interactionMode: ProviderInteractionMode;
    interactionModeEnabled: boolean;
  };
  /** Validate the fully composed text immediately before a provider turn starts. */
  validateProviderInput: (providerInput: string) => boolean;
}

// --------------------------------------------------------------------------
// Props
// --------------------------------------------------------------------------

export interface ChatComposerProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  attachmentUploadsCapabilityKnown?: boolean;
  supportsAttachmentUploads?: boolean;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;

  // Thread context
  activeThreadId: ThreadId | null;
  activeThreadEnvironmentId: EnvironmentId | undefined;
  activeThread: Thread | undefined;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  forceExpandedOnMobile: boolean;
  projectSelectionRequired: boolean;

  // Session phase
  phase: SessionPhase;
  isConnecting: boolean;
  isSendBusy: boolean;
  sendDisabledReason?: string | null;
  hasExternalSendableContent?: boolean;
  isPreparingWorktree: boolean;
  bannerItems: readonly ComposerBannerStackItem[];
  environmentUnavailable: {
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  } | null;

  // Pending approvals / inputs
  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: {
      id: string;
      multiSelect?: boolean | undefined;
      allowCustomAnswer?: boolean | undefined;
    } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: ApprovalRequestId[];

  // Plan
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: Thread["proposedPlans"][number] | null;
  activeTasksProgress: ComposerTasksProgress | null;
  activeTaskSteps: readonly ComposerTaskStep[] | null;
  threadSyncPhase: ThreadSyncPhase | null;

  // Mode
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;

  // Provider / model
  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;

  // Context window
  activeContextWindow?: ContextWindowSnapshot | null;
  usageLimitsSources?: ReadonlyArray<UsageLimitsActivitySource>;
  compactDisabled?: boolean;
  compactDisabledReason?: string | null;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  gitCwd: string | null;
  restingControlsHost?: HTMLDivElement | null;
  restingControlsHaveLeadingContext?: boolean;
  onRestingControlsVisibilityChange?: (visible: boolean) => void;
  getTimelineScrollableNode?: () => HTMLElement | null;
  isTimelineAtLogicalEnd?: () => boolean;
  onComposerOverlayHeightChange?: (height: number) => void;

  // Refs the parent needs kept in sync
  promptRef: React.RefObject<string>;
  composerImagesRef: React.RefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: React.RefObject<TerminalContextDraft[]>;
  composerElementContextsRef: React.RefObject<ElementContextDraft[]>;
  composerRef: React.RefObject<ChatComposerHandle | null>;
  onPageScrollKeyDown?: (key: "PageUp" | "PageDown") => void;
  onPageScrollKeyUp?: (key: string) => void;
  onPageScrollRelease?: () => void;

  // Callbacks
  onSend: (e?: { preventDefault: () => void }, intent?: ComposerSubmissionIntent) => void;
  onInterrupt: () => void;
  canPauseTurn?: boolean;
  canResumeInterruptedTurn?: boolean;
  onResumeInterruptedTurn?: () => void;
  onImplementPlanInNewThread: () => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  onSelectActivePendingUserInputOption: (questionId: string, optionValue: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onSkipActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;

  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;

  focusComposer: () => void;
  scheduleComposerFocus: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  variant?: "default" | "inline";
  inlineEdit?: {
    onCancel: () => void;
    isSubmitting: boolean;
  };
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    composerDraftTarget,
    environmentId,
    attachmentUploadsCapabilityKnown = false,
    supportsAttachmentUploads = false,
    routeKind,
    routeThreadRef,
    draftId,
    activeThreadId,
    activeThreadEnvironmentId: _activeThreadEnvironmentId,
    activeThread,
    isServerThread: _isServerThread,
    isLocalDraftThread: _isLocalDraftThread,
    forceExpandedOnMobile,
    projectSelectionRequired,
    phase,
    isConnecting,
    isSendBusy,
    sendDisabledReason: externalSendDisabledReason = null,
    hasExternalSendableContent = false,
    isPreparingWorktree,
    bannerItems,
    environmentUnavailable,
    activePendingApproval,
    pendingApprovals,
    pendingUserInputs,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    activeTasksProgress,
    activeTaskSteps,
    threadSyncPhase,
    runtimeMode,
    interactionMode: requestedInteractionMode,
    lockedProvider,
    providerStatuses,
    activeProjectDefaultModelSelection,
    activeThreadModelSelection,
    activeContextWindow = null,
    usageLimitsSources = [],
    compactDisabled = false,
    compactDisabledReason = null,
    resolvedTheme,
    settings,
    keybindings,
    terminalOpen,
    gitCwd,
    restingControlsHost = null,
    restingControlsHaveLeadingContext = false,
    onRestingControlsVisibilityChange = NOOP,
    getTimelineScrollableNode = NO_TIMELINE_SCROLLABLE_NODE,
    isTimelineAtLogicalEnd = TIMELINE_AT_LOGICAL_END,
    onComposerOverlayHeightChange = NOOP,
    promptRef,
    composerRef,
    composerImagesRef,
    composerTerminalContextsRef,
    composerElementContextsRef,
    onPageScrollKeyDown = NOOP,
    onPageScrollKeyUp = NOOP,
    onPageScrollRelease = NOOP,
    onSend,
    onInterrupt,
    canPauseTurn = false,
    canResumeInterruptedTurn = false,
    onResumeInterruptedTurn = NOOP,
    onImplementPlanInNewThread,
    onRespondToApproval,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onSkipActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    onOpenProviderSetup,
    getModelDisabledReason,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    focusComposer,
    scheduleComposerFocus,
    setThreadError,
    onExpandImage,
    variant = "default",
    inlineEdit,
  } = props;
  const isInlineComposer = variant === "inline";
  // ------------------------------------------------------------------
  // Store subscriptions (prompt / images / terminal contexts)
  // ------------------------------------------------------------------
  const composerDraft = useComposerThreadDraft(composerDraftTarget);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerElementContexts = composerDraft.elementContexts;
  const composerPreviewAnnotations = composerDraft.previewAnnotations;
  const composerReviewComments = composerDraft.reviewComments;
  const standaloneComposerImages = useMemo(() => {
    const previewAnnotationIds = new Set(
      composerPreviewAnnotations.map((annotation) => annotation.id),
    );
    return composerImages.filter((image) => !previewAnnotationIds.has(image.id));
  }, [composerImages, composerPreviewAnnotations]);
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const attachmentBlockReason = supportsAttachmentUploads
    ? attachmentUploadBlockReason({
        imageIds: composerImages.map((image) => image.id),
        uploadsByImageId,
        environmentId,
      })
    : null;

  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const removeComposerDraftElementContext = useComposerDraftStore(
    (store) => store.removeElementContext,
  );
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const clearComposerDraftPromptAndImages = useComposerDraftStore(
    (store) => store.clearComposerPromptAndImages,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  useEffect(() => {
    if (!attachmentUploadsCapabilityKnown) {
      return;
    }
    if (!supportsAttachmentUploads) {
      for (const image of composerImages) {
        releaseAttachmentUpload(image.id);
      }
      return;
    }
    for (const image of composerImages) {
      startAttachmentUpload({ environmentId, image });
    }
  }, [attachmentUploadsCapabilityKnown, composerImages, environmentId, supportsAttachmentUploads]);

  // ------------------------------------------------------------------
  // Model state
  // ------------------------------------------------------------------
  // Instance-aware projection of the wire provider list. One entry per
  // configured instance (default built-in + any custom `providerInstances.*`),
  // sorted default-first per driver kind for a stable picker order.
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const {
    selectedProviderEntry,
    requestedDriverKind,
    lockedContinuationGroupKey,
    unavailableProviderInstanceId,
  } = useMemo(
    () =>
      resolveComposerProviderSelection({
        entries: providerInstanceEntries,
        candidateInstanceIds: [
          selectedProviderByThreadId,
          activeThread?.session?.providerInstanceId,
          activeThreadModelSelection?.instanceId,
          activeProjectDefaultModelSelection?.instanceId,
        ],
        lockedProvider,
        lockedInstanceId:
          activeThread?.session?.providerInstanceId ?? activeThreadModelSelection?.instanceId,
      }),
    [
      activeProjectDefaultModelSelection?.instanceId,
      activeThread?.session?.providerInstanceId,
      activeThreadModelSelection?.instanceId,
      selectedProviderByThreadId,
      lockedProvider,
      providerInstanceEntries,
    ],
  );
  const selectedInstanceId =
    selectedProviderEntry?.instanceId ?? NO_PROVIDER_MODEL_SELECTION.instanceId;
  const noProviderAvailable = selectedProviderEntry === undefined;
  const providerSetupInstanceId = noProviderAvailable
    ? (unavailableProviderInstanceId ??
      (lockedProvider === null
        ? providerInstanceEntries.find((entry) => hasProviderSetup(entry.snapshot))?.instanceId
        : undefined))
    : undefined;
  const resolvedCompactDisabledReason =
    compactDisabledReason ?? (noProviderAvailable ? "Compacting is unavailable right now" : null);
  // The driver kind follows the instance that will actually run the turn,
  // which can differ from the persisted selection when that selection is
  // disabled.
  const selectedProvider: ProviderDriverKind =
    selectedProviderEntry?.driverKind ?? requestedDriverKind;
  const activeUsageLimits = useMemo(
    () =>
      deriveLatestUsageLimitsSnapshotForSources(
        usageLimitsSources,
        selectedProvider,
        selectedInstanceId,
      ),
    [selectedInstanceId, selectedProvider, usageLimitsSources],
  );

  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadRef: composerDraftTarget,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: activeThreadModelSelection,
    projectModelSelection: activeProjectDefaultModelSelection,
    settings,
  });
  const providerSendBlockReason = getAntigravitySendBlockReason(
    selectedProviderEntry?.snapshot,
    selectedModel,
  );
  const sendDisabledReason =
    externalSendDisabledReason ??
    (activePendingProgress ? null : (attachmentBlockReason ?? providerSendBlockReason));
  const isSendDisabled = sendDisabledReason !== null;
  const selectedProviderStatus = useMemo(
    () => selectedProviderEntry?.snapshot ?? null,
    [selectedProviderEntry],
  );
  const selectedProviderSkills = selectedProviderStatus
    ? resolveProviderSkillsForCwd(selectedProviderStatus, gitCwd)
    : [];
  const selectedProviderSlashCommands = selectedProviderStatus
    ? resolveProviderSlashCommandsForCwd(selectedProviderStatus, gitCwd)
    : [];
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const workspaceRefreshKeyRef = useRef<string | null>(null);
  const workspaceRefreshRetryRef = useRef<{ key: string; notBefore: number } | null>(null);
  const hadWorkspaceSnapshotRef = useRef(false);
  useEffect(() => {
    const hasWorkspaceSnapshot = Boolean(
      gitCwd &&
      selectedProviderStatus?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === gitCwd),
    );
    if (hadWorkspaceSnapshotRef.current && !hasWorkspaceSnapshot) {
      workspaceRefreshKeyRef.current = null;
      workspaceRefreshRetryRef.current = null;
    }
    hadWorkspaceSnapshotRef.current = hasWorkspaceSnapshot;
  }, [gitCwd, selectedProviderStatus]);
  useEffect(() => {
    if (!gitCwd || !selectedProviderEntry) return;
    const key = `${environmentId}:${selectedProviderEntry.instanceId}:${gitCwd}`;
    const hasWorkspaceSnapshot = selectedProviderStatus?.workspaceSnapshots?.some(
      (snapshot) => snapshot.cwd === gitCwd,
    );
    if (workspaceRefreshKeyRef.current === key) return;
    if (hasWorkspaceSnapshot) {
      workspaceRefreshKeyRef.current = key;
      workspaceRefreshRetryRef.current = null;
      return;
    }
    const retry = workspaceRefreshRetryRef.current;
    if (retry?.key === key && Date.now() < retry.notBefore) return;
    workspaceRefreshKeyRef.current = key;
    const retryLater = () => {
      if (workspaceRefreshKeyRef.current !== key) return;
      workspaceRefreshKeyRef.current = null;
      workspaceRefreshRetryRef.current = {
        key,
        notBefore: Date.now() + WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS,
      };
    };
    void refreshProviders({
      environmentId,
      input: { instanceId: selectedProviderEntry.instanceId, cwd: gitCwd },
    }).then((result) => {
      const hasWorkspaceSnapshot =
        result._tag === "Success" &&
        result.value.providers
          .find((provider) => provider.instanceId === selectedProviderEntry.instanceId)
          ?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === gitCwd);
      if (!hasWorkspaceSnapshot && workspaceRefreshKeyRef.current === key) {
        retryLater();
      }
    }, retryLater);
  }, [environmentId, gitCwd, prompt, refreshProviders, selectedProviderEntry]);
  const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider["models"][number]>>(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry],
  );

  const composerPromptInjectionState = useMemo(
    () => getComposerPromptInjectionState(prompt),
    [prompt],
  );
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        promptInjectionState: composerPromptInjectionState,
        modelOptions: composerModelOptions?.[selectedInstanceId],
        planModeEnabled: settings.planModeEnabled,
      }),
    [
      composerModelOptions,
      composerPromptInjectionState,
      selectedInstanceId,
      selectedModel,
      selectedProvider,
      selectedProviderModels,
      settings.planModeEnabled,
    ],
  );

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const { enabled: planModeUiEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: selectedProviderStatus,
    interactionMode: requestedInteractionMode,
  });
  const selectedModelSelection = useMemo<ModelSelection>(
    () => createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch),
    [selectedInstanceId, selectedModel, selectedModelOptionsForDispatch],
  );
  const selectedModelForPicker = selectedModel;
  // Instance-keyed option list so the picker can show each configured
  // instance (built-in + custom) as a first-class sidebar entry. The
  // options are server-reported models plus that exact instance's
  // configured custom models; selected slugs are not injected into lists.
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of providerInstanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [providerInstanceEntries, settings]);
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByInstance, selectedInstanceId, selectedModelForPicker, selectedProvider]);

  // ------------------------------------------------------------------
  // Context window
  // ------------------------------------------------------------------
  const activeThreadModelDisplayName = useMemo(
    () => resolveContextWindowModelDisplayName(activeThreadModelSelection, modelOptionsByInstance),
    [activeThreadModelSelection, modelOptionsByInstance],
  );

  // ------------------------------------------------------------------
  // Composer-local state
  // ------------------------------------------------------------------
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
    null,
  );
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isComposerScrollCollapsed, setIsComposerScrollCollapsed] = useState(false);
  const [composerSubmissionError, setComposerSubmissionError] = useState<string | null>(null);
  const [providerInputSubmissionError, setProviderInputSubmissionError] = useState<string | null>(
    null,
  );
  const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  const [isTasksDrawerOpen, setIsTasksDrawerOpen] = useState(false);
  const [stashPulse, setStashPulse] = useState<{ key: number; active: boolean }>({
    key: 0,
    active: false,
  });
  const isMobileViewport = useMediaQuery("max-sm");
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const isComposerCollapsedMobile =
    isMobileViewport && !forceExpandedOnMobile && !isComposerFocused;

  // ------------------------------------------------------------------
  // Refs
  // ------------------------------------------------------------------
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFooterControlsRef = useRef<HTMLDivElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const providerInputRejectedRef = useRef(false);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const composerBlurFrameRef = useRef<number | null>(null);
  const mobileComposerExpandFrameRef = useRef<number | null>(null);
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
  const mobileComposerExpandInFlightRef = useRef(false);
  const desktopOutsidePointerInFlightRef = useRef(false);
  const desktopOutsidePointerReleaseTimeoutRef = useRef<number | null>(null);
  const composerScrollCollapseTimeoutRef = useRef<number | null>(null);
  const composerScrollCollapseEligibleRef = useRef(false);
  const windowRefocusInFlightRef = useRef(false);
  const composerScrollGestureRef = useRef(createComposerScrollGestureState());
  const stashPulseKeyRef = useRef(0);
  const stashPulseTimeoutRef = useRef<number | null>(null);
  /**
   * Snapshots currently being encoded, keyed by target+prompt+image ids.
   * Keyed rather than boolean so a genuinely different prompt (or a different
   * thread) can still be stashed while an earlier encode is running.
   */
  const stashInFlightRef = useRef<Set<string>>(new Set());
  /**
   * Count of pasted images still being compressed, per thread. Reserved
   * against the attachment limit so concurrent pastes can't overshoot it,
   * and checked before sending or compacting so an image cannot move into
   * the next draft.
   */
  const pendingImageCompressionsRef = useRef<Map<ThreadId, number>>(new Map());

  // ------------------------------------------------------------------
  // Derived: composer send state
  // ------------------------------------------------------------------
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
        elementContextCount:
          composerElementContexts.length +
          composerPreviewAnnotations.length +
          composerReviewComments.length,
      }),
    [
      composerElementContexts.length,
      composerImages.length,
      composerPreviewAnnotations.length,
      composerReviewComments.length,
      composerTerminalContexts,
      prompt,
    ],
  );
  const hasSendableContent = composerSendState.hasSendableContent || hasExternalSendableContent;

  // ------------------------------------------------------------------
  // Derived: composer trigger / menu
  // ------------------------------------------------------------------
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? gitCwd : null,
    query: isPathTrigger ? pathTriggerQuery : null,
  });

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.entries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
      }));
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        ...(planModeUiEnabled
          ? ([
              {
                id: "slash:plan",
                type: "slash-command",
                command: "plan",
                label: "/plan",
                description: "Switch this thread into plan mode",
              },
              {
                id: "slash:default",
                type: "slash-command",
                command: "default",
                label: "/default",
                description: "Switch this thread back to normal build mode",
              },
            ] as const)
          : []),
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const slashMenuSkills = getProviderSkillsForSlashMenu(
        selectedProviderSkills,
        settings.showSkillsInSlashMenu,
      );
      const providerSlashCommandItems = getProviderSlashCommandsForSlashMenu(
        selectedProviderSlashCommands,
        slashMenuSkills,
      ).map((command) => ({
        id: `provider-slash-command:${selectedProvider}:${command.name}`,
        type: "provider-slash-command" as const,
        provider: selectedProvider,
        command,
        label: `/${command.name}`,
        description: command.description ?? command.input?.hint ?? "Run provider command",
      }));
      const query = composerTrigger.query.trim().toLowerCase();
      const skillItems = slashMenuSkills.map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: `/skill:${skill.name}`,
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : ""),
      }));
      const slashCommandItems = [
        ...builtInSlashCommandItems,
        ...providerSlashCommandItems,
        ...skillItems,
      ];
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderSkills, composerTrigger.query).map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
      }));
    }
    return [];
  }, [
    composerTrigger,
    planModeUiEnabled,
    selectedProvider,
    selectedProviderSkills,
    selectedProviderSlashCommands,
    selectedProviderStatus,
    settings.showSkillsInSlashMenu,
    workspaceEntries.entries,
  ]);

  const composerMenuOpen = Boolean(composerTrigger);
  const composerMenuSearchKey = composerTrigger
    ? `${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null;
  const activeComposerMenuItem = useMemo(() => {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    return composerMenuItems.find((item) => item.id === activeItemId) ?? null;
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuSearchKey,
  ]);

  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );

  const isComposerApprovalState = activePendingApproval !== null;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const isChoiceOnlyPendingQuestion =
    activePendingProgress?.activeQuestion?.allowCustomAnswer === false;
  const showComposerTopDrawer =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (!isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan !== null);
  const showCollapsedMobilePromptRow =
    isComposerCollapsedMobile && !isComposerApprovalState && pendingUserInputs.length === 0;
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (phase === "running") {
      return "running";
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    phase,
    prompt,
    showPlanFollowUpPrompt,
  ]);

  const isComposerMenuLoading =
    composerTriggerKind === "path" && pathTriggerQuery.length > 0 && workspaceEntries.isPending;
  const composerMenuEmptyState = useMemo(() => {
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    return composerTriggerKind === "path"
      ? "No matching files or folders."
      : "No matching command.";
  }, [composerTriggerKind]);

  // ------------------------------------------------------------------
  // Provider traits UI
  // ------------------------------------------------------------------
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      if (nextPrompt === promptRef.current) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [composerDraftTarget, promptRef, scheduleComposerFocus, setComposerDraftPrompt],
  );

  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
    planModeEnabled: settings.planModeEnabled,
  });
  const providerTraitsPickerInput = {
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
    planModeEnabled: settings.planModeEnabled,
    isComposerOwned: true,
  } satisfies Parameters<typeof renderProviderTraitsPicker>[0];
  const providerTraitsPicker = renderProviderTraitsPicker(providerTraitsPickerInput);
  const restingProviderTraitsPicker = renderProviderTraitsPicker({
    ...providerTraitsPickerInput,
    size: "xs",
  });
  const {
    controlsRef: restingComposerControlsRef,
    hiddenBlockCount: restingControlsHiddenBlockCount,
    controlsVisible: restingControlsVisible,
  } = useRestingComposerControlsLayout(restingControlsHost);
  const pendingPrimaryAction = useMemo(
    () =>
      activePendingProgress
        ? {
            questionIndex: activePendingProgress.questionIndex,
            isLastQuestion: activePendingProgress.isLastQuestion,
            canAdvance: activePendingProgress.canAdvance,
            isResponding: activePendingIsResponding,
            isComplete: Boolean(activePendingResolvedAnswers),
          }
        : null,
    [activePendingIsResponding, activePendingProgress, activePendingResolvedAnswers],
  );
  const collapsedComposerPrimaryActionDisabled =
    phase === "running" ||
    isSendBusy ||
    isSendDisabled ||
    isConnecting ||
    noProviderAvailable ||
    projectSelectionRequired ||
    environmentUnavailable !== null ||
    (!hasSendableContent && !canResumeInterruptedTurn);
  const collapsedComposerPrimaryActionLabel = canResumeInterruptedTurn
    ? "Resume turn"
    : "Send message";
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;
  // ------------------------------------------------------------------
  // Prompt helpers
  // ------------------------------------------------------------------
  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    },
    [composerDraftTarget, setComposerDraftPrompt],
  );

  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(composerDraftTarget, image);
    },
    [composerDraftTarget, addComposerDraftImage],
  );

  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(composerDraftTarget, images);
    },
    [composerDraftTarget, addComposerDraftImages],
  );

  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      releaseAttachmentUpload(imageId);
      removeComposerDraftImage(composerDraftTarget, imageId);
    },
    [composerDraftTarget, removeComposerDraftImage],
  );

  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) return;
      const removal = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = removal.prompt;
      setPrompt(removal.prompt);
      removeComposerDraftTerminalContext(composerDraftTarget, contextId);
      const nextCursor = collapseExpandedComposerCursor(removal.prompt, removal.cursor);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(removal.prompt, removal.cursor));
    },
    [
      composerDraftTarget,
      composerTerminalContexts,
      promptRef,
      removeComposerDraftTerminalContext,
      setPrompt,
    ],
  );

  // ------------------------------------------------------------------
  // Sync refs back to parent
  // ------------------------------------------------------------------
  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt, promptRef]);

  useEffect(() => {
    if (composerSubmissionError === null) return;
    const nextError = getComposerPromptLengthValidationMessage(prompt);
    if (nextError !== composerSubmissionError) {
      setComposerSubmissionError(nextError);
    }
  }, [composerSubmissionError, prompt]);

  useEffect(() => {
    setProviderInputSubmissionError(null);
  }, [
    composerElementContexts,
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContexts,
    prompt,
    selectedModel,
    selectedPromptEffort,
    selectedProvider,
  ]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts, composerTerminalContextsRef]);

  useEffect(() => {
    composerElementContextsRef.current = composerElementContexts;
  }, [composerElementContexts, composerElementContextsRef]);

  // ------------------------------------------------------------------
  // Composer menu highlight sync
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      setComposerHighlightedSearchKey(null);
      return;
    }
    const nextActiveItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    setComposerHighlightedItemId((existing) =>
      existing === nextActiveItemId ? existing : nextActiveItemId,
    );
    setComposerHighlightedSearchKey((existing) =>
      existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
    );
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
  ]);

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    activePendingUserInput?.requestId,
    promptRef,
  ]);

  // ------------------------------------------------------------------
  // Reset compositor state on thread/draft change
  // ------------------------------------------------------------------
  useEffect(() => {
    setComposerHighlightedItemId(null);
    setComposerSubmissionError(null);
    setProviderInputSubmissionError(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    setIsDragOverComposer(false);
    setIsComposerScrollCollapsed(false);
  }, [draftId, activeThreadId, promptRef]);

  // ------------------------------------------------------------------
  // Footer compact layout observation
  // ------------------------------------------------------------------
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const footerCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const primaryActionsCompact =
        footerCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });
      return {
        primaryActionsCompact,
        footerCompact,
      };
    };

    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;
    const footerControls = composerFooterControlsRef.current;
    const stopFooterControlsFade = footerControls
      ? observeResponsiveBreakpointFade({
          target: footerControls,
          container: composerForm,
          active: panelAnimationsActive,
          durationMs: panelAnimationDurationMs,
          breakpoint: {
            value: composerFooterHasWideActions
              ? COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
              : COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX,
            unit: "px",
          },
        })
      : undefined;

    const observer = new ResizeObserver(() => {
      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
      stopFooterControlsFade?.();
    };
  }, [
    activeThreadId,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    isComposerApprovalState,
    isComposerCollapsedMobile,
    panelAnimationDurationMs,
    panelAnimationsActive,
  ]);

  // ------------------------------------------------------------------
  // Image persist effect
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(composerDraftTarget);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(composerDraftTarget)?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds: Array<string> = [];
        for (const attachment of fallbackPersistedAttachments) {
          if (currentImageIds.has(attachment.id)) {
            fallbackPersistedIds.push(attachment.id);
          }
        }
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    composerDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerImages,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: prompt change
  // ------------------------------------------------------------------
  const expandComposerForEditorChange = useCallback(() => {
    // Editor changes win over the momentum tail of the active scroll gesture.
    suppressActiveComposerScrollGesture(
      composerScrollGestureRef.current,
      window.performance.now(),
      COMPOSER_SCROLL_GESTURE_RESET_MS,
    );
    setIsComposerScrollCollapsed(false);
  }, []);

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      expandComposerForEditorChange();
      if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
        if (activePendingProgress.activeQuestion.allowCustomAnswer === false) return;
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          composerDraftTarget,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      expandComposerForEditorChange,
      pendingUserInputs.length,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
      composerDraftTarget,
      composerTerminalContexts,
      setComposerDraftTerminalContexts,
    ],
  );

  // ------------------------------------------------------------------
  // Callbacks: prompt replacement / menu
  // ------------------------------------------------------------------
  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: {
        expectedText?: string;
        focusEditorAfterReplace?: boolean;
        citationComment?: { start: number; sourceAnchor: AssistantCitationSourceAnchor };
      },
    ): boolean => {
      if (
        activePendingUserInput &&
        activePendingProgress?.activeQuestion?.allowCustomAnswer === false
      ) {
        return false;
      }
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor);
      if (options?.citationComment) {
        composerEditorRef.current?.requestCitationComment({
          previousValue: currentText,
          value: next.text,
          citationStart: options.citationComment.start,
          sourceAnchor: options.citationComment.sourceAnchor,
        });
      }
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          next.text,
          nextCursor,
          nextExpandedCursor,
          false,
        );
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor));
      if (options?.focusEditorAfterReplace !== false) {
        window.requestAnimationFrame(() => {
          // Type-to-focus routes only the first key through here; once the
          // controlled update focuses the editor, later keys land natively.
          // Skip the deferred caret placement when the draft has moved on,
          // or it drags the caret back behind what was typed since.
          if (promptRef.current !== next.text) return;
          composerEditorRef.current?.focusAt(nextCursor);
        });
      }
      return true;
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
    ],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts, promptRef]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `${serializeComposerFileLink(item.path)} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            setIsComposerModelPickerOpen(true);
          }
          return;
        }
        if (!planModeUiEnabled) return;
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "provider-slash-command") {
        const replacement = `/${item.command.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "skill") {
        const replacement = `$${item.skill.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
    },
    [
      applyPromptReplacement,
      handleInteractionModeChange,
      planModeUiEnabled,
      resolveActiveComposerTrigger,
    ],
  );

  const onComposerMenuItemHighlighted = useCallback(
    (itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
      setComposerHighlightedSearchKey(composerMenuSearchKey);
    },
    [composerMenuSearchKey],
  );

  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) return;
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );

  const blurMobileComposerAfterSend = useCallback(() => {
    if (!isMobileViewport) return;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    setIsComposerFocused(false);
  }, [isMobileViewport]);

  const shouldBlurMobileComposerOnSubmit = useCallback(() => {
    if (!isMobileViewport) return false;
    if (
      isSendBusy ||
      isSendDisabled ||
      isConnecting ||
      noProviderAvailable ||
      environmentUnavailable !== null ||
      phase === "running"
    ) {
      return false;
    }
    if (activePendingProgress) {
      return activePendingProgress.isLastQuestion && Boolean(activePendingResolvedAnswers);
    }
    return showPlanFollowUpPrompt || hasSendableContent;
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    hasSendableContent,
    environmentUnavailable,
    isConnecting,
    isMobileViewport,
    isSendBusy,
    isSendDisabled,
    noProviderAvailable,
    phase,
    showPlanFollowUpPrompt,
  ]);

  const submitComposer = useCallback(
    (event?: { preventDefault: () => void }, intent: ComposerSubmissionIntent = "foreground") => {
      if (noProviderAvailable || isSendDisabled) {
        event?.preventDefault();
        return;
      }
      // A send while a pasted image is still compressing would strand that
      // image: the turn snapshot wouldn't include it, and it would surface
      // in the *next* draft instead. Only oversized images hit this — small
      // files clear the pending counter within a microtask.
      if (activeThreadId && (pendingImageCompressionsRef.current.get(activeThreadId) ?? 0) > 0) {
        event?.preventDefault();
        toastManager.add({
          type: "info",
          title: "Still compressing a pasted image.",
          description: "Send again once its thumbnail appears.",
        });
        return;
      }
      const submission = submitComposerDraft({
        prompt: promptRef.current,
        submissionTarget: activePendingProgress ? "pending-user-input" : "provider-turn",
        event,
        onSend: (sendEvent) => {
          // ChatView reports its final composed-input preflight through the
          // composer handle before its first asynchronous send step.
          providerInputRejectedRef.current = false;
          onSend(sendEvent, intent);
          return !providerInputRejectedRef.current;
        },
      });
      setComposerSubmissionError(submission.validationMessage);
      if (!submission.didDispatch) return;
      if (shouldBlurMobileComposerOnSubmit()) {
        blurMobileComposerAfterSend();
      }
    },
    [
      activeThreadId,
      activePendingProgress,
      blurMobileComposerAfterSend,
      isSendDisabled,
      noProviderAvailable,
      onSend,
      promptRef,
      shouldBlurMobileComposerOnSubmit,
    ],
  );
  const compactThreadContext = useCallback(() => {
    if (
      compactDisabled ||
      noProviderAvailable ||
      composerSendState.hasSendableContent ||
      activePendingApproval !== null ||
      pendingUserInputs.length > 0 ||
      phase === "running" ||
      isSendBusy ||
      isConnecting ||
      !activeThreadId
    ) {
      return;
    }
    // The compact buttons cannot see the compression counter (it lives in
    // a ref), so they render enabled during a paste; toast instead of
    // silently ignoring the click.
    if ((pendingImageCompressionsRef.current.get(activeThreadId) ?? 0) > 0) {
      toastManager.add({
        type: "info",
        title: "Still compressing a pasted image.",
        description: "Compact again once its thumbnail appears.",
      });
      return;
    }

    promptRef.current = "/compact";
    setComposerDraftPrompt(composerDraftTarget, "/compact");
    submitComposer();
    // A blocked dispatch (busy send ref, provider preflight rejection)
    // would leave the injected "/compact" behind as if the user typed it.
    // Clearing here is safe even when the send did dispatch: the send
    // snapshots its prompt synchronously and clears the draft itself.
    if (promptRef.current === "/compact") {
      promptRef.current = "";
      setComposerDraftPrompt(composerDraftTarget, "");
    }
  }, [
    activePendingApproval,
    activeThreadId,
    compactDisabled,
    composerDraftTarget,
    composerSendState.hasSendableContent,
    isConnecting,
    isSendBusy,
    noProviderAvailable,
    pendingUserInputs.length,
    phase,
    promptRef,
    setComposerDraftPrompt,
    submitComposer,
  ]);
  const expandMobileComposer = useCallback(() => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      composerEditorRef.current?.focusAtEnd();
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
      });
    });
  }, []);

  // ------------------------------------------------------------------
  // Callbacks: command key
  // ------------------------------------------------------------------
  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      if (!planModeUiEnabled) return false;
      toggleInteractionMode();
      return true;
    }
    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;
    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if ((key === "Enter" || key === "Tab") && selectedItem) {
        onSelectComposerItem(selectedItem);
        return true;
      }
    }
    const submissionIntent =
      key === "Enter"
        ? composerSubmissionIntentForEnter({
            isMobileViewport,
            shiftKey: event.shiftKey,
            modifierKey: event.metaKey || event.ctrlKey,
            isDraftThread: routeKind === "draft",
          })
        : null;
    if (submissionIntent) {
      submitComposer(undefined, submissionIntent);
      return true;
    }
    return false;
  };

  // ------------------------------------------------------------------
  // Prompt stash (⌘S)
  // ------------------------------------------------------------------
  // One global queue. Stashed prompts carry only text + images so they can be
  // restored into any thread or provider — stash, switch, restore is the
  // whole point.
  const stashQueue = usePromptStashStore((state) => state.entries);
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry);
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry);
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages);

  useEffect(() => {
    return () => {
      if (stashPulseTimeoutRef.current !== null) {
        window.clearTimeout(stashPulseTimeoutRef.current);
      }
    };
  }, []);

  /** Briefly highlight the badge so the save registers without a flourish. */
  const pulseStashBadge = useCallback(() => {
    stashPulseKeyRef.current += 1;
    setStashPulse({ key: stashPulseKeyRef.current, active: true });
    if (stashPulseTimeoutRef.current !== null) {
      window.clearTimeout(stashPulseTimeoutRef.current);
    }
    stashPulseTimeoutRef.current = window.setTimeout(() => {
      stashPulseTimeoutRef.current = null;
      setStashPulse((current) => ({ ...current, active: false }));
    }, 1200);
  }, []);

  const restoreStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      // Remove first so a double activation (click + Enter) can't restore twice.
      const { entry: taken, durable } = takeStashEntry(entry.id);
      if (!taken) return;
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Restored prompt may reappear in the stash",
          description:
            "Browser storage rejected the update, so this entry could still be there after a reload.",
          data: { hideCopyButton: true },
        });
      }
      setIsStashMenuOpen(false);

      const currentPrompt = promptRef.current;
      // An image-only stash must not append blank lines to whatever is
      // already in the composer.
      const nextPrompt =
        entry.prompt.length === 0
          ? currentPrompt
          : currentPrompt.trim().length
            ? `${currentPrompt.replace(/\s+$/, "")}\n\n${entry.prompt}`
            : entry.prompt;
      const promptChanged = nextPrompt !== currentPrompt;
      if (promptChanged) {
        promptRef.current = nextPrompt;
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
        setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
        setComposerTrigger(null);
      }

      let unrestoredImageNames: string[] = [];
      if (entry.attachments.length > 0) {
        const existingIds = new Set(composerImagesRef.current.map((image) => image.id));
        // The draft store also dedupes by mimeType+sizeBytes+name, so filter
        // on the same key here. Counting a duplicate against capacity would
        // burn a slot the store then refuses to fill, pushing a genuinely
        // unique image into the overflow list for nothing.
        const existingDedupKeys = new Set(
          composerImagesRef.current.map(
            (image) => `${image.mimeType}\0${image.sizeBytes}\0${image.name}`,
          ),
        );
        const capacity = Math.max(
          0,
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS - composerImagesRef.current.length,
        );
        const pending = entry.attachments.filter(
          (attachment) =>
            !existingIds.has(attachment.id) &&
            !existingDedupKeys.has(
              `${attachment.mimeType}\0${attachment.sizeBytes}\0${attachment.name}`,
            ),
        );
        // Anything past the attachment limit cannot be restored. The entry is
        // already out of the queue, so report the overflow by name instead of
        // discarding it silently.
        unrestoredImageNames = pending.slice(capacity).map((attachment) => attachment.name);
        const restoredImages = hydrateImagesFromPersisted(pending.slice(0, capacity));
        if (restoredImages.length > 0) {
          addComposerDraftImages(composerDraftTarget, restoredImages);
        }
      }

      // Deliberately no model/provider restore: the stash exists to carry a
      // prompt across threads and providers, so whatever the composer has
      // selected right now stays selected.

      // Each cause gets its own sentence so "too large" is never blamed for a
      // file that actually failed to decode, or for one the composer simply
      // had no room to take back.
      const missingImageReasons: string[] = [];
      if (entry.droppedImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.droppedImageNames.join(", ")} exceeded the stash size limit when this prompt was saved.`,
        );
      }
      if (entry.unreadableImageNames && entry.unreadableImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.unreadableImageNames.join(", ")} could not be read when this prompt was saved.`,
        );
      }
      if (unrestoredImageNames.length > 0) {
        missingImageReasons.push(
          `${unrestoredImageNames.join(", ")} could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-image limit.`,
        );
      }
      if (missingImageReasons.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Some images were not restored",
          description: missingImageReasons.join(" "),
        });
      }

      // Only yank the caret to the end when text was actually inserted;
      // restoring images alone should leave the user where they were typing.
      if (promptChanged) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAtEnd();
        });
      }
    },
    [
      addComposerDraftImages,
      composerDraftTarget,
      composerImagesRef,
      promptRef,
      setComposerDraftPrompt,
      takeStashEntry,
    ],
  );

  const deleteStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      const { durable } = takeStashEntry(entry.id);
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stash entry may come back",
          description:
            "Browser storage rejected the delete, so this prompt could reappear after a reload.",
          data: { hideCopyButton: true },
        });
      }
    },
    [takeStashEntry],
  );

  const stashCurrentPrompt = useCallback(async () => {
    // Terminal-context placeholders reference live sessions the stash can't
    // round-trip, so they are stripped from the stashed prompt.
    const prompt = promptRef.current.split(INLINE_TERMINAL_CONTEXT_PLACEHOLDER).join("").trim();
    const images = [...composerImagesRef.current];
    if (prompt.length === 0 && images.length === 0) {
      setIsStashMenuOpen((open) => !open);
      return;
    }
    // A repeat ⌘S on the *same* still-unencoded snapshot would stash it
    // twice. Guard on the snapshot itself rather than a bare boolean: once
    // the composer has been cleared the user can type something genuinely
    // new (or switch threads) while encoding continues, and that deserves its
    // own entry.
    const snapshotKey = `${String(composerDraftTarget)} ${prompt} ${images
      .map((image) => image.id)
      .join(",")}`;
    if (stashInFlightRef.current.has(snapshotKey)) return;
    stashInFlightRef.current.add(snapshotKey);

    const stashTarget = composerDraftTarget;
    const entryId = randomUUID();
    try {
      // Persist the text-only entry *first*, then clear. Ordering matters in
      // both directions: writing before clearing means a crash or closed tab
      // mid-encode still leaves the prompt recoverable, while clearing before
      // the async image work means edits typed during encoding are not wiped.
      // Images are appended to the stored entry as they finish encoding.
      const { evicted, written, durable } = stashEntryToQueue({
        id: entryId,
        createdAt: new Date().toISOString(),
        prompt,
        attachments: [],
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: images.length,
      });

      // Clearing the composer is only safe once the write actually landed.
      // If it was rejected (quota) the store has already rolled itself back,
      // so leave the composer untouched rather than making it the second
      // casualty of a reload.
      if (!written) {
        toastManager.add({
          type: "error",
          title: "Could not stash this prompt",
          description:
            "Browser storage rejected the write, so the composer was left as-is. Free up site data and try again.",
          data: { hideCopyButton: true },
        });
        return;
      }
      // Written but only into the in-memory fallback (localStorage blocked):
      // the entry is visible and restorable this session, so proceed with the
      // clear, but say it won't survive a reload.
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stashed prompt will not survive a reload",
          description:
            "Browser storage is unavailable, so this stash is kept in memory only for this session.",
          data: { hideCopyButton: true },
        });
      }

      // Only the prompt and images are cleared — terminal/element contexts,
      // preview annotations, and review comments are not stashable, so
      // destroying them here would be unrecoverable.
      promptRef.current = "";
      clearComposerDraftPromptAndImages(stashTarget);
      for (const image of images) {
        releaseAttachmentUpload(image.id);
      }
      setComposerCursor(0);
      setComposerTrigger(null);
      pulseStashBadge();

      if (evicted) {
        toastManager.add({
          type: "warning",
          title: "Oldest stashed prompt discarded",
          description: `The stash holds ${MAX_STASH_ENTRIES} prompts; the oldest was removed to make room.`,
          data: { hideCopyButton: true },
        });
      }

      // Images are re-encoded for the stash rather than stored verbatim: the
      // composer allows up to 10MB per image, but localStorage gives the whole
      // origin ~5MB. Only the stashed copy shrinks; the live attachment (and
      // anything sent without stashing) keeps the original file.
      const candidateAttachments: PersistedComposerImageAttachment[] = [];
      const oversizedImageNames: string[] = [];
      const unreadableImageNames: string[] = [];
      for (const image of images) {
        const result = await compressImageForStash(image.file);
        if (!result.ok) {
          // "too large" and "could not be read" are distinct outcomes; the
          // menu and restore toast report them separately.
          (result.reason === "too-large" ? oversizedImageNames : unreadableImageNames).push(
            image.name,
          );
          continue;
        }
        candidateAttachments.push({
          id: image.id,
          name: image.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
        });
      }
      const { kept, droppedNames } = partitionStashAttachments(candidateAttachments);

      const { attached, durable: imagesDurable } = finalizeStashEntryImages(entryId, {
        attachments: kept,
        droppedImageNames: [...oversizedImageNames, ...droppedNames],
        unreadableImageNames,
      });
      if (attached) {
        // The second phase can be rejected on its own: the text-only entry
        // fit, but adding image payloads pushed past the quota. Disk would
        // then still hold the phase-one entry with pendingImageCount set,
        // which reads as an orphan after reload — so say so now. Gated on the
        // entry write having been durable: on the in-memory fallback nothing
        // is ever durable, and the session-only warning already covered it.
        if (!imagesDurable && durable && images.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Stashed images were not saved",
            description:
              "The prompt was stashed, but browser storage rejected its images. They will be missing if you reload.",
            data: { hideCopyButton: true },
          });
        }
      } else if (kept.length > 0) {
        // The entry was restored or deleted before its images finished
        // encoding, so they have nowhere to land. Say so rather than letting
        // them evaporate.
        toastManager.add({
          type: "warning",
          title: "Stashed images did not attach",
          description: `That prompt was restored or deleted before ${kept.length} image${kept.length === 1 ? "" : "s"} finished saving. Re-attach ${kept.length === 1 ? "it" : "them"} if you still need ${kept.length === 1 ? "it" : "them"}.`,
          data: { hideCopyButton: true },
        });
      }
    } finally {
      // Must clear on every path: a throw that left this set would wedge this
      // snapshot's ⌘S until the composer remounts.
      stashInFlightRef.current.delete(snapshotKey);
    }
  }, [
    clearComposerDraftPromptAndImages,
    composerDraftTarget,
    composerImagesRef,
    finalizeStashEntryImages,
    promptRef,
    pulseStashBadge,
    stashEntryToQueue,
  ]);

  const toggleStashMenu = useCallback(() => {
    if (isComposerCollapsedMobile) {
      expandMobileComposer();
      setIsStashMenuOpen(true);
      return;
    }
    setIsStashMenuOpen((open) => !open);
  }, [expandMobileComposer, isComposerCollapsedMobile]);
  const toggleTasksDrawer = useCallback(() => {
    setIsTasksDrawerOpen((open) => !open);
  }, []);
  const hasBannerItems = bannerItems.length > 0;
  const hasBlockingComposerTopDrawer =
    activePendingApproval !== null || pendingUserInputs.length > 0;
  const showInlineTasksBadge =
    activeTasksProgress !== null &&
    activeTaskSteps !== null &&
    !isTasksDrawerOpen &&
    !hasBlockingComposerTopDrawer &&
    (hasBannerItems || showComposerTopDrawer || isComposerCollapsedMobile);
  const inlineTasksBadge = showInlineTasksBadge ? (
    <ComposerTasksBadge
      expanded={false}
      onToggle={toggleTasksDrawer}
      placement="inline"
      progress={activeTasksProgress}
      steps={activeTaskSteps}
    />
  ) : null;
  const hasImageAttachmentAttention = standaloneComposerImages.some((image) => {
    const upload = uploadsByImageId[image.id];
    const failedInCurrentEnvironment =
      supportsAttachmentUploads &&
      upload?.status === "failed" &&
      upload.environmentId === environmentId;
    // A failed upload remains actionable in the expanded attachment tray, but
    // its collapsed thumbnail is enough to signal that the draft has images.
    return nonPersistedComposerImageIdSet.has(image.id) && !failedInCurrentEnvironment;
  });
  // Banners and the tasks badge dock above the surface rather than inside
  // it, so they do not hold the composer open; only surface-internal chrome
  // does.
  const composerHasExpandedChrome =
    showComposerTopDrawer ||
    isTasksDrawerOpen ||
    composerMenuOpen ||
    isStashMenuOpen ||
    isDragOverComposer ||
    isPreparingWorktree ||
    noProviderAvailable ||
    projectSelectionRequired ||
    environmentUnavailable !== null ||
    composerSubmissionError !== null ||
    providerInputSubmissionError !== null ||
    hasImageAttachmentAttention;
  const isComposerResting = shouldUseRestingComposerLayout({
    isExistingThread: routeKind === "server" && activeThreadId !== null,
    isMobileViewport,
    isFocused: isComposerFocused && !isComposerScrollCollapsed,
    hasExpandedChrome: composerHasExpandedChrome,
  });
  // The relocated controls live in the context strip whenever the composer is
  // collapsed for any reason, the desktop resting layout or the phone
  // collapse. Both leave the footer unrendered, so the strip is the only place
  // to see or change the model without expanding the composer.
  const composerControlsInStrip = isComposerResting || isComposerCollapsedMobile;
  const composerControlsVisibleInStrip = composerControlsInStrip && restingControlsVisible;
  useLayoutEffect(() => {
    onRestingControlsVisibilityChange(composerControlsVisibleInStrip);
  }, [composerControlsVisibleInStrip, onRestingControlsVisibilityChange]);
  const restingImagePreviewCounts = getRestingComposerImagePreviewCounts(
    standaloneComposerImages.length,
  );
  const restingComposerImages = standaloneComposerImages.slice(
    0,
    restingImagePreviewCounts.visibleCount,
  );
  const collapsedComposerImagePreviews =
    restingComposerImages.length > 0 ? (
      <div
        data-chat-composer-resting-images="true"
        className="flex shrink-0 items-center gap-1 ps-1"
      >
        {restingComposerImages.map((image) => (
          <button
            key={image.id}
            type="button"
            className="relative size-7 shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/60"
            aria-label={`Preview ${image.name}`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              const preview = buildExpandedImagePreview(composerImages, image.id);
              if (preview) onExpandImage(preview);
            }}
          >
            {image.previewUrl ? (
              <img src={image.previewUrl} alt="" className="size-full object-cover" />
            ) : (
              <FileIcon className="m-auto size-3.5 text-secondary-label" />
            )}
          </button>
        ))}
        {restingImagePreviewCounts.overflowCount > 0 ? (
          <button
            type="button"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-muted/60 font-medium text-secondary-label text-xs tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            aria-label={`Show ${String(restingImagePreviewCounts.overflowCount)} more image attachments`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (isComposerCollapsedMobile) {
                expandMobileComposer();
                return;
              }
              setIsComposerScrollCollapsed(false);
              setIsComposerFocused(true);
              scheduleComposerFocus();
            }}
          >
            +{restingImagePreviewCounts.overflowCount}
          </button>
        ) : null}
      </div>
    ) : null;
  const composerMainSurfaceRef = useComposerRestingTransition(
    composerControlsInStrip,
    restingComposerControlsRef,
    onComposerOverlayHeightChange,
  );
  const canTrackComposerScrollGesture =
    routeKind === "server" && activeThreadId !== null && !isMobileViewport;
  const canScrollCollapseComposer =
    canTrackComposerScrollGesture && !composerHasExpandedChrome && !showInlineTasksBadge;
  composerScrollCollapseEligibleRef.current = canScrollCollapseComposer;

  useEffect(() => {
    if (!canScrollCollapseComposer) {
      setIsComposerScrollCollapsed(false);
    }
  }, [canScrollCollapseComposer]);

  // Returning to the window re-fires focus on the element that already held
  // it. That focus arrives after the window's own event, so a window focus
  // marks the frame in which it should be ignored by the form's capture.
  useEffect(() => {
    if (!isComposerScrollCollapsed) return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      windowRefocusInFlightRef.current = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        windowRefocusInFlightRef.current = false;
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
      windowRefocusInFlightRef.current = false;
    };
  }, [isComposerScrollCollapsed]);

  useEffect(() => {
    if (!canTrackComposerScrollGesture) return;

    const finishScrollGesture = () => {
      if (composerScrollCollapseTimeoutRef.current !== null) {
        window.clearTimeout(composerScrollCollapseTimeoutRef.current);
      }
      composerScrollCollapseTimeoutRef.current = null;
      resetComposerScrollGesture(composerScrollGestureRef.current);
    };
    const handleTimelineWheel = (event: WheelEvent) => {
      const activeElement = document.activeElement;
      const isPromptEditorFocused =
        activeElement instanceof HTMLElement &&
        activeElement.isContentEditable &&
        composerFormRef.current?.contains(activeElement) === true;
      if (event.ctrlKey || !(event.target instanceof Element)) {
        return;
      }

      const scrollNode = getTimelineScrollableNode();
      if (!scrollNode) return;
      const targetsTimeline = scrollNode.contains(event.target);
      if (!targetsTimeline && !composerScrollGestureRef.current.collapseSuppressed) return;

      if (composerScrollCollapseTimeoutRef.current !== null) {
        window.clearTimeout(composerScrollCollapseTimeoutRef.current);
      }
      composerScrollCollapseTimeoutRef.current = window.setTimeout(
        finishScrollGesture,
        COMPOSER_SCROLL_GESTURE_RESET_MS,
      );

      const canScrollInGestureDirection =
        targetsTimeline &&
        (event.deltaY < 0
          ? scrollNode.scrollTop > 0
          : scrollNode.scrollTop < scrollNode.scrollHeight - scrollNode.clientHeight);
      const deltaPx =
        Math.abs(event.deltaY) *
        (event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scrollNode.clientHeight
            : 1);
      const shouldCollapse = recordComposerScrollGestureEvent(composerScrollGestureRef.current, {
        now: window.performance.now(),
        deltaPx,
        collapseThresholdPx: COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX,
        collapseEligible:
          targetsTimeline && composerScrollCollapseEligibleRef.current && isPromptEditorFocused,
        canScrollInGestureDirection,
        scrollsTowardLogicalEnd: event.deltaY > 0 && isTimelineAtLogicalEnd(),
      });
      if (!shouldCollapse) {
        return;
      }

      setIsComposerScrollCollapsed(true);
    };

    document.addEventListener("wheel", handleTimelineWheel, { capture: true, passive: true });
    return () => {
      document.removeEventListener("wheel", handleTimelineWheel, true);
      finishScrollGesture();
    };
  }, [
    activeThreadId,
    canTrackComposerScrollGesture,
    getTimelineScrollableNode,
    isTimelineAtLogicalEnd,
  ]);

  const restingHiddenBlockCount = composerControlsInStrip ? restingControlsHiddenBlockCount : 0;
  const composerControlsCompact = !composerControlsInStrip && isComposerFooterCompact;
  const restingBlockDefs = [
    ...(providerTraitsPicker
      ? [
          {
            id: "traits",
            content: (
              <>
                <ComposerControlSeparator size={composerControlsInStrip ? "xs" : "sm"} />
                {composerControlsInStrip ? restingProviderTraitsPicker : providerTraitsPicker}
              </>
            ),
          },
        ]
      : []),
    {
      id: "mode",
      content: (
        <ComposerFooterModeControls
          showInteractionModeToggle={planModeUiEnabled}
          interactionMode={interactionMode}
          runtimeMode={runtimeMode}
          size={composerControlsInStrip ? "xs" : "sm"}
          onToggleInteractionMode={toggleInteractionMode}
          onRuntimeModeChange={handleRuntimeModeChange}
        />
      ),
    },
  ];
  const hiddenRestingBlockIds = restingBlockDefs
    .slice(restingBlockDefs.length - restingHiddenBlockCount)
    .map((def) => def.id);
  const composerControls = noProviderAvailable ? (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={!providerSetupInstanceId}
      onClick={() => {
        if (providerSetupInstanceId) {
          onOpenProviderSetup(providerSetupInstanceId);
        }
      }}
      data-chat-provider-unavailable="true"
      className="shrink-0 gap-2 px-2 text-secondary-label sm:px-3"
    >
      <CircleAlertIcon className="size-4" />
      {providerSetupInstanceId ? "Open provider settings" : "No provider available"}
    </Button>
  ) : (
    <>
      {composerControlsInStrip && restingControlsHaveLeadingContext ? (
        <ComposerControlSeparator
          size="xs"
          className="@max-[400px]/composer-surface:hidden"
          data-resting-controls-separator="true"
        />
      ) : null}
      <ProviderModelPicker
        isComposerOwned
        compact={composerControlsCompact}
        activeInstanceId={selectedInstanceId}
        model={selectedModelForPickerWithCustomFallback}
        lockedProvider={lockedProvider}
        lockedContinuationGroupKey={lockedContinuationGroupKey}
        instanceEntries={providerInstanceEntries}
        keybindings={keybindings}
        modelOptionsByInstance={modelOptionsByInstance}
        size={composerControlsInStrip ? "xs" : "sm"}
        triggerClassName={
          composerControlsInStrip
            ? "min-w-13 shrink text-xs! @max-[640px]/composer-surface:[&_[data-chat-provider-model-picker-label]]:w-0 @max-[640px]/composer-surface:[&_[data-chat-provider-model-picker-label]]:flex-none"
            : "-ms-2.5"
        }
        terminalOpen={terminalOpen}
        open={isComposerModelPickerOpen}
        instanceIndicatorBackground={
          composerControlsInStrip
            ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
            : "var(--contrast-input)"
        }
        {...(composerProviderState.modelPickerIconClassName || composerControlsInStrip
          ? {
              activeProviderIconClassName: cn(
                composerProviderState.modelPickerIconClassName,
                composerControlsInStrip &&
                  "fill-muted-foreground/70! text-muted-foreground/70! [&_path]:fill-muted-foreground/70! [&_rect]:fill-muted-foreground/70!",
              ),
            }
          : {})}
        onOpenChange={setIsComposerModelPickerOpen}
        getModelDisabledReason={getModelDisabledReason}
        onInstanceModelChange={onProviderModelSelect}
        onOpenProviderSetup={onOpenProviderSetup}
      />

      {composerControlsCompact ? (
        <CompactComposerControlsMenu
          interactionMode={interactionMode}
          runtimeMode={runtimeMode}
          showInteractionModeToggle={planModeUiEnabled}
          traitsMenuContent={providerTraitsMenuContent}
          onToggleInteractionMode={toggleInteractionMode}
          onRuntimeModeChange={handleRuntimeModeChange}
        />
      ) : (
        <>
          {restingBlockDefs.map((def, index) => {
            if (!composerControlsInStrip) {
              return <Fragment key={def.id}>{def.content}</Fragment>;
            }
            const hidden = index >= restingBlockDefs.length - restingHiddenBlockCount;
            return (
              <div
                key={def.id}
                data-resting-block={def.id}
                aria-hidden={hidden || undefined}
                inert={hidden || undefined}
                className={cn(
                  "flex w-max min-w-max shrink-0 items-center gap-1",
                  hidden && "pointer-events-none invisible absolute",
                )}
              >
                {def.content}
              </div>
            );
          })}
          {composerControlsInStrip ? (
            <div
              data-resting-controls-overflow
              aria-hidden={hiddenRestingBlockIds.length === 0 || undefined}
              inert={hiddenRestingBlockIds.length === 0 || undefined}
              className={cn(
                "min-w-0 shrink-0",
                hiddenRestingBlockIds.length === 0 && "pointer-events-none invisible absolute",
              )}
            >
              <CompactComposerControlsMenu
                interactionMode={interactionMode}
                runtimeMode={runtimeMode}
                size="xs"
                hidden={hiddenRestingBlockIds.length === 0}
                showInteractionModeToggle={
                  planModeUiEnabled && hiddenRestingBlockIds.includes("mode")
                }
                traitsMenuContent={
                  hiddenRestingBlockIds.includes("traits") ? providerTraitsMenuContent : undefined
                }
                onToggleInteractionMode={toggleInteractionMode}
                onRuntimeModeChange={handleRuntimeModeChange}
              />
            </div>
          ) : null}
        </>
      )}
    </>
  );
  const showTasksTab =
    !hasBannerItems &&
    !showComposerTopDrawer &&
    !isTasksDrawerOpen &&
    !isComposerCollapsedMobile &&
    activeTasksProgress !== null &&
    activeTaskSteps !== null &&
    activeTasksProgress.totalSteps > 0;
  const activityStackContent = hasBannerItems ? (
    threadSyncPhase ? (
      <ComposerActivityRow phase={threadSyncPhase} />
    ) : !hasBlockingComposerTopDrawer && activeTasksProgress && activeTaskSteps ? (
      <ComposerTasksContent
        expanded={isTasksDrawerOpen}
        onToggle={toggleTasksDrawer}
        progress={activeTasksProgress}
        steps={activeTaskSteps}
      />
    ) : null
  ) : null;
  const activityStackItem: ComposerBannerStackContent | null = activityStackContent
    ? {
        id: "composer-activity",
        variant: "default",
        priority: "activity",
        content: activityStackContent,
      }
    : null;
  const bannerStackItems = activityStackItem ? [activityStackItem, ...bannerItems] : bannerItems;

  useEffect(() => {
    if (activeTasksProgress === null || activeTaskSteps === null) {
      setIsTasksDrawerOpen(false);
    }
  }, [activeTaskSteps, activeTasksProgress]);

  useEffect(() => {
    if (hasBlockingComposerTopDrawer) {
      setIsTasksDrawerOpen(false);
    }
  }, [hasBlockingComposerTopDrawer]);

  useEffect(() => {
    setIsTasksDrawerOpen(false);
  }, [activeThreadId]);

  // Close the stash menu whenever the trigger-driven command menu opens so
  // the two popovers never stack in the same layer, and when the user
  // resumes typing (the menu is a transient picker, not a panel).
  useEffect(() => {
    if (composerMenuOpen) {
      setIsStashMenuOpen(false);
    }
  }, [composerMenuOpen]);
  useEffect(() => {
    setIsStashMenuOpen(false);
  }, [prompt]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen,
          modelPickerOpen: isComposerModelPickerOpen,
        },
      });
      if (command !== "composer.stash") return;
      // Always claim the shortcut so the browser save dialog never opens,
      // even when the composer is in a state that can't stash.
      event.preventDefault();
      event.stopPropagation();
      if (
        isCommandPaletteOpen() ||
        isComposerApprovalState ||
        pendingUserInputs.length > 0 ||
        projectSelectionRequired ||
        activePendingProgress !== null
      ) {
        return;
      }
      void stashCurrentPrompt();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activePendingProgress,
    isComposerApprovalState,
    isComposerModelPickerOpen,
    keybindings,
    pendingUserInputs.length,
    projectSelectionRequired,
    stashCurrentPrompt,
    terminalOpen,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: images
  // ------------------------------------------------------------------
  const addComposerImages = async (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;
    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }
    // Captured before the awaits below: the user may switch threads while a
    // large image is being compressed, and the attachments and errors belong
    // to the thread the paste happened in.
    const threadId = activeThreadId;

    // Validation happens synchronously so concurrent pastes see each other:
    // accepted files reserve their attachment slots (via the pending counter)
    // before the first await, keeping the total under the limit.
    const pendingCount = pendingImageCompressionsRef.current.get(threadId) ?? 0;
    let reservedCount = composerImagesRef.current.length + pendingCount;
    const acceptedFiles: File[] = [];
    let error: string | null = null;
    for (const file of files) {
      const isHeicImage = isHeicImageFile(file);
      if (!file.type.startsWith("image/") && !isHeicImage) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (!isHeicImage && !isProviderSendTurnSupportedImageMimeType(file.type)) {
        error = `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
        continue;
      }
      if (reservedCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }
      acceptedFiles.push(file);
      reservedCount += 1;
    }
    setThreadError(threadId, error);
    if (acceptedFiles.length === 0) return;

    pendingImageCompressionsRef.current.set(threadId, pendingCount + acceptedFiles.length);
    try {
      const nextImages: ComposerImageAttachment[] = [];
      let compressionError: string | null = null;
      for (const file of acceptedFiles) {
        // Images over the wire cap are downscaled to fit rather than
        // refused; files already within it pass through byte-for-byte.
        const compressed = await prepareImageForAttachment(
          file,
          PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
        );
        if (!compressed.ok) {
          compressionError =
            compressed.reason === "unreadable"
              ? `'${file.name}' could not be read as an image.`
              : `'${file.name}' is too large to attach, even after compression.`;
          continue;
        }
        const attachmentFile = compressed.file;
        const previewUrl = URL.createObjectURL(attachmentFile);
        nextImages.push({
          type: "image",
          id: randomUUID(),
          name: attachmentFile.name || "image",
          mimeType: attachmentFile.type,
          sizeBytes: attachmentFile.size,
          previewUrl,
          file: attachmentFile,
        });
      }
      if (nextImages.length === 1 && nextImages[0]) {
        addComposerImage(nextImages[0]);
      } else if (nextImages.length > 1) {
        addComposerImagesToDraft(nextImages);
      }
      // Only failures are reported here. Success must not pass `null`: by
      // now other work (a failed send, an overlapping paste) may have set a
      // thread error this call knows nothing about, and clearing it would
      // swallow that message.
      if (compressionError !== null) {
        setThreadError(threadId, compressionError);
      }
    } finally {
      const remaining =
        (pendingImageCompressionsRef.current.get(threadId) ?? 0) - acceptedFiles.length;
      if (remaining > 0) {
        pendingImageCompressionsRef.current.set(threadId, remaining);
      } else {
        pendingImageCompressionsRef.current.delete(threadId);
      }
    }
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  // ------------------------------------------------------------------
  // Callbacks: paste / drag
  // ------------------------------------------------------------------
  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    const imageFiles = files.filter(
      (file) => file.type.startsWith("image/") || isHeicImageFile(file),
    );
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void addComposerImages(imageFiles);
  };

  const insertComposerText = useCallback(
    (
      text: string,
      position: "cursor" | "end",
      options?: {
        ensureLeadingBoundary?: boolean;
        citationCommentAnchor?: AssistantCitationSourceAnchor;
      },
    ): boolean => {
      if (
        text.length === 0 ||
        isConnecting ||
        isComposerApprovalState ||
        pendingUserInputs.length > 0 ||
        projectSelectionRequired ||
        (options?.citationCommentAnchor && !composerEditorRef.current)
      ) {
        return false;
      }
      const prompt = promptRef.current;
      const cursor = position === "cursor" ? readComposerSnapshot().expandedCursor : prompt.length;
      const needsLeadingSpace =
        (options?.ensureLeadingBoundary ?? false) &&
        cursor > 0 &&
        !/\s/.test(prompt[cursor - 1] ?? "");
      const rangeEnd = extendReplacementRangeForTrailingSpace(prompt, cursor, text);
      return applyPromptReplacement(
        cursor,
        rangeEnd,
        needsLeadingSpace ? ` ${text}` : text,
        options?.citationCommentAnchor
          ? {
              citationComment: {
                start: cursor + (needsLeadingSpace ? 1 : 0),
                sourceAnchor: options.citationCommentAnchor,
              },
              focusEditorAfterReplace: false,
            }
          : undefined,
      );
    },
    [
      applyPromptReplacement,
      isComposerApprovalState,
      isConnecting,
      pendingUserInputs.length,
      projectSelectionRequired,
      promptRef,
      readComposerSnapshot,
    ],
  );

  const insertComposerTextAtEnd = useCallback<ChatComposerHandle["insertTextAtEnd"]>(
    (text, options) => {
      const inserted = insertComposerText(text, "end", options);
      if (inserted && isComposerCollapsedMobile) {
        // The expanded editor is hidden at phone widths, so its scheduled
        // focus cannot expand the composer by itself. Reveal it before the
        // focus frame runs to preserve type-to-focus and external inserts.
        expandMobileComposer();
      }
      return inserted;
    },
    [expandMobileComposer, insertComposerText, isComposerCollapsedMobile],
  );

  // File-tree drags land as mentions. Handled in the capture phase so the
  // editor never sees the drop; the load-bearing rules (native stop, "move"
  // effect, no eager focus) live in makeComposerMentionDragHandlers.
  const composerMentionDragHandlers = makeComposerMentionDragHandlers({
    insertMentionAtEnd: (text) => insertComposerTextAtEnd(text, { ensureLeadingBoundary: true }),
    setDragActive: setIsDragOverComposer,
    onInsertRejected: () => {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
    },
  });

  const onComposerMentionDragLeaveCapture = (event: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) return;
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDragOverComposer(false);
  };

  // A cancelled drag (Escape) can end without a dragleave on the hovered
  // target, which would leave the drop highlight stuck. dragend always fires
  // on the in-page drag source and bubbles to window, so it is the reset of
  // last resort while the highlight is up.
  useEffect(() => {
    if (!isDragOverComposer) return;
    const onWindowDragEnd = () => {
      setIsDragOverComposer(false);
    };
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [isDragOverComposer]);
  const handleInterruptPrimaryAction = useCallback(() => {
    void onInterrupt();
  }, [onInterrupt]);
  const handleImplementPlanInNewThreadPrimaryAction = useCallback(() => {
    void onImplementPlanInNewThread();
  }, [onImplementPlanInNewThread]);
  const scheduleComposerCollapseCheck = useCallback(() => {
    if (isMobileViewport && mobileComposerExpandInFlightRef.current) {
      return;
    }
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (isMobileViewport && mobileComposerExpandInFlightRef.current) {
        return;
      }
      if (!isMobileViewport && desktopOutsidePointerInFlightRef.current) {
        return;
      }
      const composerSurface = composerSurfaceRef.current;
      const activeElement = document.activeElement;
      if (activeElement instanceof Element && isInsideComposerFloatingLayer(activeElement)) {
        return;
      }
      if (
        composerSurface &&
        activeElement instanceof Node &&
        composerSurface.contains(activeElement)
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  }, [isMobileViewport]);

  useEffect(() => {
    if (isMobileViewport || !isComposerFocused) return;

    const isInsideDesktopComposerFocusScope = (target: EventTarget | null) =>
      Boolean(
        target instanceof Node &&
        (composerFormRef.current?.contains(target) ||
          (target instanceof Element && isInsideComposerFloatingLayer(target))),
      );
    const handleFocusIn = (event: FocusEvent) => {
      if (!isInsideDesktopComposerFocusScope(event.target)) {
        if (desktopOutsidePointerInFlightRef.current) {
          return;
        }
        setIsComposerFocused(false);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!isInsideDesktopComposerFocusScope(event.target)) {
        desktopOutsidePointerInFlightRef.current = true;
        if (desktopOutsidePointerReleaseTimeoutRef.current !== null) {
          window.clearTimeout(desktopOutsidePointerReleaseTimeoutRef.current);
          desktopOutsidePointerReleaseTimeoutRef.current = null;
        }
      }
    };
    const finishOutsidePointerInteraction = () => {
      desktopOutsidePointerInFlightRef.current = false;
      if (desktopOutsidePointerReleaseTimeoutRef.current !== null) {
        window.clearTimeout(desktopOutsidePointerReleaseTimeoutRef.current);
        desktopOutsidePointerReleaseTimeoutRef.current = null;
      }
      scheduleComposerCollapseCheck();
    };
    const handlePointerUp = () => {
      if (!desktopOutsidePointerInFlightRef.current) return;
      desktopOutsidePointerReleaseTimeoutRef.current = window.setTimeout(() => {
        if (desktopOutsidePointerInFlightRef.current) {
          finishOutsidePointerInteraction();
        }
      }, 0);
    };
    const handleClick = () => {
      if (desktopOutsidePointerInFlightRef.current) {
        finishOutsidePointerInteraction();
      }
    };

    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", handlePointerUp, true);
    document.addEventListener("click", handleClick);
    return () => {
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("pointercancel", handlePointerUp, true);
      document.removeEventListener("click", handleClick);
      if (desktopOutsidePointerReleaseTimeoutRef.current !== null) {
        window.clearTimeout(desktopOutsidePointerReleaseTimeoutRef.current);
        desktopOutsidePointerReleaseTimeoutRef.current = null;
      }
      desktopOutsidePointerInFlightRef.current = false;
    };
  }, [isComposerFocused, isMobileViewport, scheduleComposerCollapseCheck]);

  useEffect(() => {
    return () => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      if (mobileComposerExpandFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      }
    };
  }, []);

  // ------------------------------------------------------------------
  // Imperative handle
  // ------------------------------------------------------------------
  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () => {
        composerEditorRef.current?.focusAtEnd();
      },
      focusAt: (cursor: number) => {
        composerEditorRef.current?.focusAt(cursor);
      },
      restoreAfterTimelineReachedEnd: () => {
        setIsComposerScrollCollapsed(false);
      },
      addDroppedFiles: (files: File[]) => {
        void addComposerImages(files);
        focusComposer();
      },
      insertTextAtEnd: insertComposerTextAtEnd,
      citeAssistantText: (citation, sourceAnchor) =>
        insertComposerText(
          formatAssistantCitationForComposer(citation, citation.comment),
          "cursor",
          { ensureLeadingBoundary: true, citationCommentAnchor: sourceAnchor },
        ),
      openModelPicker: () => {
        setIsComposerModelPickerOpen(true);
      },
      toggleModelPicker: () => {
        setIsComposerModelPickerOpen((open) => !open);
      },
      cycleReasoningEffort: () => {
        const nextOptions = cycleComposerReasoningEffort({
          provider: selectedProvider,
          model: selectedModel,
          models: selectedProviderModels,
          modelOptions: composerModelOptions?.[selectedInstanceId],
          planModeEnabled: settings.planModeEnabled,
        });
        if (!nextOptions) return;
        setProviderModelOptions(composerDraftTarget, selectedProvider, nextOptions, {
          instanceId: selectedInstanceId,
          model: selectedModel,
          persistSticky: true,
        });
      },
      compactContext: compactThreadContext,
      isModelPickerOpen: () => isComposerModelPickerOpen,
      readSnapshot: () => {
        return readComposerSnapshot();
      },
      resetCursorState: (options?: {
        cursor?: number;
        prompt?: string;
        detectTrigger?: boolean;
      }) => {
        const promptForState = options?.prompt ?? promptRef.current;
        const cursor = clampCollapsedComposerCursor(promptForState, options?.cursor ?? 0);
        setComposerHighlightedItemId(null);
        setComposerCursor(cursor);
        setComposerTrigger(
          options?.detectTrigger
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        );
      },
      addTerminalContext: (selection: TerminalContextSelection) => {
        if (!activeThread || isChoiceOnlyPendingQuestion) return;
        const snapshot = composerEditorRef.current?.readSnapshot() ?? {
          value: promptRef.current,
          cursor: composerCursor,
          expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
          terminalContextIds: composerTerminalContexts.map((context) => context.id),
        };
        const insertion = insertInlineTerminalContextPlaceholder(
          snapshot.value,
          snapshot.expandedCursor,
        );
        const nextCollapsedCursor = collapseExpandedComposerCursor(
          insertion.prompt,
          insertion.cursor,
        );
        const inserted = insertComposerDraftTerminalContext(
          composerDraftTarget,
          insertion.prompt,
          {
            id: randomUUID(),
            threadId: activeThread.id,
            createdAt: new Date().toISOString(),
            ...selection,
          },
          insertion.contextIndex,
        );
        if (!inserted) return;
        promptRef.current = insertion.prompt;
        setComposerCursor(nextCollapsedCursor);
        setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCollapsedCursor);
        });
      },
      getSendContext: () => ({
        prompt: promptRef.current,
        images: composerImagesRef.current,
        terminalContexts: composerTerminalContextsRef.current,
        elementContexts: composerElementContextsRef.current,
        previewAnnotations: composerPreviewAnnotations,
        reviewComments: composerReviewComments,
        selectedPromptEffort,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        providerAvailable: !noProviderAvailable && providerSendBlockReason === null,
        selectedProvider,
        selectedModel,
        selectedProviderModels,
        interactionMode,
        interactionModeEnabled: planModeUiEnabled,
      }),
      validateProviderInput: (providerInput: string) => {
        const validationMessage = getComposerSubmissionValidationMessage({
          prompt: promptRef.current,
          providerInput,
          submissionTarget: "provider-turn",
        });
        providerInputRejectedRef.current = validationMessage !== null;
        setProviderInputSubmissionError(validationMessage);
        return validationMessage === null;
      },
    }),
    [
      activeThread,
      addComposerImages,
      composerDraftTarget,
      composerCursor,
      composerTerminalContexts,
      insertComposerDraftTerminalContext,
      insertComposerText,
      insertComposerTextAtEnd,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      composerElementContextsRef,
      composerPreviewAnnotations,
      composerReviewComments,
      focusComposer,
      isConnecting,
      isComposerApprovalState,
      isChoiceOnlyPendingQuestion,
      pendingUserInputs.length,
      projectSelectionRequired,
      applyPromptReplacement,
      isComposerModelPickerOpen,
      readComposerSnapshot,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedModelSelection,
      noProviderAvailable,
      providerSendBlockReason,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
      composerModelOptions,
      selectedInstanceId,
      setProviderModelOptions,
      interactionMode,
      planModeUiEnabled,
      compactThreadContext,
    ],
  );

  // Render
  // ------------------------------------------------------------------
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposer}
      className={cn("w-full min-w-0", isInlineComposer ? "max-w-none" : "mx-auto max-w-3xl")}
      data-chat-composer-form="true"
      data-chat-composer-variant={variant}
    >
      {composerControlsInStrip && restingControlsHost
        ? createPortal(
            <div
              ref={restingComposerControlsRef}
              data-chat-composer-resting-controls="true"
              aria-hidden={restingControlsVisible ? undefined : true}
              inert={restingControlsVisible ? undefined : true}
              className={cn(
                "relative flex w-max min-w-0 max-w-full items-center gap-1 font-normal text-muted-foreground/70 [&_button]:text-xs!",
                !restingControlsVisible && "invisible",
              )}
            >
              {composerControls}
            </div>,
            restingControlsHost,
          )
        : null}
      <ComposerBanner.Dock>
        <ComposerBanner.Column>
          <ComposerBannerStack
            key={activeThreadId}
            className="relative z-0"
            items={bannerStackItems}
          />
          {!activityStackItem && (threadSyncPhase || inlineTasksBadge) ? (
            <ComposerBanner.Attachment>
              <ComposerBanner.Root data-chat-composer-activity-strip="true">
                {threadSyncPhase ? (
                  <ComposerActivityRow phase={threadSyncPhase} />
                ) : (
                  inlineTasksBadge
                )}
              </ComposerBanner.Root>
            </ComposerBanner.Attachment>
          ) : null}
          {showComposerTopDrawer && (!isTasksDrawerOpen || hasBlockingComposerTopDrawer) ? (
            <ComposerBanner.Attachment>
              <ComposerBanner.Root
                data-chat-composer-top-drawer="true"
                variant={activePendingApproval ? "warning" : "info"}
              >
                {activePendingApproval ? (
                  <ComposerBanner.Row
                    layout="wrap-actions"
                    data-chat-composer-collapsed-controls="true"
                  >
                    <ComposerBanner.Icon />
                    <ComposerBanner.Content>
                      <ComposerPendingApprovalPanel
                        approval={activePendingApproval}
                        pendingCount={pendingApprovals.length}
                      />
                    </ComposerBanner.Content>
                    <ComposerBanner.Actions>
                      <ComposerPendingApprovalActions
                        requestId={activePendingApproval.requestId}
                        isResponding={respondingRequestIds.includes(
                          activePendingApproval.requestId,
                        )}
                        options={activePendingApproval.options}
                        onRespondToApproval={onRespondToApproval}
                      />
                    </ComposerBanner.Actions>
                  </ComposerBanner.Row>
                ) : !isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    respondingRequestIds={respondingRequestIds}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onSelectActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                    onSkip={onSkipActivePendingUserInput}
                  />
                ) : !isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan ? (
                  <ComposerPlanFollowUpBanner
                    key={activeProposedPlan.id}
                    planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                  />
                ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
                  <div data-chat-composer-collapsed-controls="true">
                    <ComposerPendingUserInputPanel
                      pendingUserInputs={pendingUserInputs}
                      respondingRequestIds={respondingRequestIds}
                      answers={activePendingDraftAnswers}
                      questionIndex={activePendingQuestionIndex}
                      onToggleOption={onSelectActivePendingUserInputOption}
                      onAdvance={onAdvanceActivePendingUserInput}
                      onSkip={onSkipActivePendingUserInput}
                    />
                    {!isChoiceOnlyPendingQuestion ||
                    activePendingProgress?.activeQuestion?.multiSelect ? (
                      <ComposerBanner.Body>
                        <div
                          data-chat-composer-mobile-pending-compact="true"
                          className={cn(
                            "flex min-w-0 items-center gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5 pl-3 transition-colors hover:bg-background/80",
                            !activePendingProgress?.activeQuestion?.multiSelect && "p-0",
                          )}
                        >
                          {!isChoiceOnlyPendingQuestion ? (
                            <button
                              type="button"
                              className={cn(
                                "min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm",
                                activePendingProgress?.customAnswer
                                  ? "text-foreground"
                                  : "text-placeholder",
                                !activePendingProgress?.activeQuestion?.multiSelect && "px-3 py-2",
                              )}
                              onPointerDown={(event) => event.preventDefault()}
                              onClick={expandMobileComposer}
                              aria-label="Write custom answer"
                            >
                              {activePendingProgress?.customAnswer || "Write custom answer"}
                            </button>
                          ) : null}
                          {activePendingProgress?.activeQuestion?.multiSelect ? (
                            <ComposerPrimaryActions
                              compact
                              pendingAction={pendingPrimaryAction}
                              isRunning={false}
                              showPlanFollowUpPrompt={false}
                              promptHasText={false}
                              isSendBusy={isSendBusy}
                              sendDisabledReason={sendDisabledReason}
                              isConnecting={isConnecting}
                              isEnvironmentUnavailable={
                                environmentUnavailable !== null ||
                                noProviderAvailable ||
                                projectSelectionRequired
                              }
                              isPreparingWorktree={false}
                              hasSendableContent={false}
                              preserveComposerFocusOnPointerDown
                              onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                              onInterrupt={handleInterruptPrimaryAction}
                              onImplementPlanInNewThread={
                                handleImplementPlanInNewThreadPrimaryAction
                              }
                            />
                          ) : null}
                        </div>
                      </ComposerBanner.Body>
                    ) : null}
                  </div>
                ) : null}
              </ComposerBanner.Root>
            </ComposerBanner.Attachment>
          ) : null}
          {!activityStackItem &&
          isTasksDrawerOpen &&
          !hasBlockingComposerTopDrawer &&
          activeTasksProgress &&
          activeTaskSteps ? (
            <ComposerTasksDrawer
              onCollapse={toggleTasksDrawer}
              progress={activeTasksProgress}
              steps={activeTaskSteps}
            />
          ) : null}
          {showTasksTab ? (
            <ComposerBanner.Attachment>
              <ComposerTasksBadge
                expanded={false}
                onToggle={toggleTasksDrawer}
                progress={activeTasksProgress}
                steps={activeTaskSteps}
              />
            </ComposerBanner.Attachment>
          ) : null}
        </ComposerBanner.Column>
        {!isComposerApprovalState && !isInlineComposer ? (
          <ComposerStashBadge
            count={stashQueue.length}
            menuOpen={isStashMenuOpen}
            pulseKey={stashPulse.key}
            pulsing={stashPulse.active}
            onToggleMenu={toggleStashMenu}
          />
        ) : null}
      </ComposerBanner.Dock>
      <ComposerSurface.Main
        className={cn(
          isInlineComposer && "rounded-xl",
          composerProviderState.composerFrameClassName,
        )}
        onDragEnterCapture={composerMentionDragHandlers.onDragEnter}
        onDragOverCapture={composerMentionDragHandlers.onDragOver}
        onDragLeaveCapture={onComposerMentionDragLeaveCapture}
        onDropCapture={composerMentionDragHandlers.onDrop}
      >
        <div
          ref={composerSurfaceRef}
          data-chat-composer-surface="true"
          data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
          className={cn(
            "rounded-[20px] transition-[background-color] duration-200",
            isInlineComposer &&
              "rounded-xl border border-border bg-card has-focus-visible:border-ring/45",
            isDragOverComposer ? "bg-accent/45 ring-1 ring-primary/70" : null,
            projectSelectionRequired ? "opacity-75" : null,
            composerProviderState.composerSurfaceClassName,
          )}
          onFocusCapture={(event) => {
            const activeElement = event.target;
            if (
              isComposerCollapsedMobile &&
              activeElement instanceof HTMLElement &&
              activeElement.closest('[data-chat-composer-collapsed-controls="true"]')
            ) {
              return;
            }
            if (composerBlurFrameRef.current !== null) {
              window.cancelAnimationFrame(composerBlurFrameRef.current);
              composerBlurFrameRef.current = null;
            }
            setIsComposerFocused(true);
          }}
          onBlurCapture={() => {
            scheduleComposerCollapseCheck();
          }}
        >
          {inlineEdit !== undefined ? (
            <div className="rounded-t-xl border-b border-border/65 bg-muted/20 px-3 py-2 text-xs sm:px-4">
              <span className="min-w-0 text-muted-foreground">
                Editing this message will discard later conversation history.
              </span>
            </div>
          ) : null}

          {showCollapsedMobilePromptRow ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                data-chat-composer-transition-prompt="true"
                className={cn(
                  "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-[14px] focus:outline-none",
                  (activePendingProgress ? activePendingProgress.customAnswer : prompt.trim())
                    ? "text-foreground"
                    : "text-placeholder",
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={isChoiceOnlyPendingQuestion ? undefined : expandMobileComposer}
                disabled={isChoiceOnlyPendingQuestion}
                aria-label="Expand composer"
              >
                {activePendingProgress
                  ? isChoiceOnlyPendingQuestion
                    ? "Choose an option above"
                    : activePendingProgress.customAnswer ||
                      "Type your own answer, or leave this blank to use the selected option"
                  : prompt.trim() ||
                    (noProviderAvailable
                      ? "Enable a provider in Settings"
                      : hasExternalSendableContent
                        ? "Optional overall note…"
                        : "Ask anything...")}
              </button>
              {collapsedComposerImagePreviews}
              <button
                type="button"
                data-chat-composer-transition-actions="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover disabled:opacity-30"
                disabled={collapsedComposerPrimaryActionDisabled}
                aria-label={collapsedComposerPrimaryActionLabel}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (canResumeInterruptedTurn && !hasSendableContent) {
                    onResumeInterruptedTurn();
                  } else {
                    submitComposer();
                  }
                }}
              >
                {canResumeInterruptedTurn && !hasSendableContent ? (
                  <PlayIcon className="size-4" aria-hidden="true" />
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M8 3L8 13M8 3L4 7M8 3L12 7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            </div>
          ) : null}

          <div
            ref={setComposerMenuAnchor}
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              inlineEdit !== undefined ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
              isComposerCollapsedMobile && "hidden",
            )}
          >
            {isInlineComposer ? (
              <ComposerStashBadge
                count={stashQueue.length}
                placement="tab"
                pulseKey={stashPulse.key}
                pulsing={stashPulse.active}
                menuOpen={isStashMenuOpen}
                onToggleMenu={toggleStashMenu}
              />
            ) : null}

            {isStashMenuOpen && !composerMenuOpen && !isComposerApprovalState && (
              <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                <ComposerStashMenu
                  entries={stashQueue}
                  stashShortcutLabel={shortcutLabelForCommand(keybindings, "composer.stash", {
                    context: {
                      terminalFocus: false,
                      terminalOpen,
                      modelPickerOpen: false,
                    },
                  })}
                  onRestore={restoreStashEntry}
                  onDelete={deleteStashEntry}
                  onClose={() => setIsStashMenuOpen(false)}
                />
              </ComposerCommandMenuLayer>
            )}

            {composerMenuOpen && !isComposerApprovalState && (
              <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                <ComposerCommandMenu
                  items={composerMenuItems}
                  resolvedTheme={resolvedTheme}
                  isLoading={isComposerMenuLoading}
                  triggerKind={composerTriggerKind}
                  emptyStateText={composerMenuEmptyState}
                  activeItemId={activeComposerMenuItem?.id ?? null}
                  onHighlightedItemChange={onComposerMenuItemHighlighted}
                  onSelect={onSelectComposerItem}
                />
              </ComposerCommandMenuLayer>
            )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerPreviewAnnotations.length > 0 && (
                <ComposerPreviewAnnotationCards
                  annotations={composerPreviewAnnotations}
                  images={composerImages}
                  {...(supportsAttachmentUploads
                    ? {
                        uploadsByImageId,
                        onRetryUpload: (image: ComposerImageAttachment) =>
                          retryAttachmentUpload({ environmentId, image }),
                      }
                    : {})}
                  onRemove={(annotationId) => {
                    releaseAttachmentUpload(annotationId);
                    removeComposerDraftPreviewAnnotation(composerDraftTarget, annotationId);
                  }}
                  onExpandImage={(imageId) => {
                    const preview = buildExpandedImagePreview(composerImages, imageId);
                    if (preview) onExpandImage(preview);
                  }}
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerReviewComments.length > 0 && (
                <ComposerPendingReviewComments
                  comments={composerReviewComments}
                  onRemove={(commentId) =>
                    removeComposerDraftReviewComment(composerDraftTarget, commentId)
                  }
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerElementContexts.length > 0 && (
                <ComposerPendingElementContexts
                  contexts={composerElementContexts}
                  onRemove={(contextId) =>
                    removeComposerDraftElementContext(composerDraftTarget, contextId)
                  }
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerImages.some(
                (image) =>
                  !composerPreviewAnnotations.some((annotation) => annotation.id === image.id),
              ) && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {composerImages
                    .filter(
                      (image) =>
                        !composerPreviewAnnotations.some(
                          (annotation) => annotation.id === image.id,
                        ),
                    )
                    .map((image) => {
                      const upload = supportsAttachmentUploads
                        ? uploadsByImageId[image.id]
                        : undefined;
                      return (
                        <div
                          key={image.id}
                          className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={`Preview ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(composerImages, image.id);
                                if (!preview) return;
                                onExpandImage(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="h-full w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-secondary-label">
                              {image.name}
                            </div>
                          )}
                          {nonPersistedComposerImageIdSet.has(image.id) && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span
                                    role="img"
                                    aria-label="Draft attachment may not persist"
                                    className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                  >
                                    <CircleAlertIcon className="size-3" />
                                  </span>
                                }
                              />
                              <TooltipPopup
                                side="top"
                                className="max-w-64 whitespace-normal leading-tight"
                              >
                                Draft attachment could not be saved locally and may be lost on
                                navigation.
                              </TooltipPopup>
                            </Tooltip>
                          )}
                          {upload?.status === "uploading" && (
                            <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-[10px] text-foreground">
                              {formatAttachmentUploadProgress(upload.progress)}
                            </span>
                          )}
                          {upload?.status === "failed" && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="absolute bottom-1 left-1 bg-background/85 hover:bg-background/95"
                                    onClick={() => retryAttachmentUpload({ environmentId, image })}
                                    aria-label={`Retry upload for ${image.name}`}
                                  />
                                }
                              >
                                <RotateCcwIcon />
                              </TooltipTrigger>
                              <TooltipPopup
                                side="top"
                                className="max-w-64 whitespace-normal leading-tight"
                              >
                                {upload.reason}
                              </TooltipPopup>
                            </Tooltip>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                            onClick={() => removeComposerImage(image.id)}
                            aria-label={`Remove ${image.name}`}
                          >
                            <XIcon />
                          </Button>
                        </div>
                      );
                    })}
                </div>
              )}

            <div className="relative">
              <ComposerPromptEditor
                editorRef={composerEditorRef}
                value={
                  isComposerApprovalState
                    ? ""
                    : activePendingProgress
                      ? activePendingProgress.customAnswer
                      : prompt
                }
                cursor={composerCursor}
                terminalContexts={
                  !isComposerApprovalState && pendingUserInputs.length === 0
                    ? composerTerminalContexts
                    : []
                }
                skills={selectedProviderSkills}
                {...(showMobilePendingAnswerActions ? { className: "max-sm:pb-11" } : {})}
                onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                onChange={onPromptChange}
                onCommandKeyDown={onComposerCommandKey}
                onPaste={onComposerPaste}
                placeholder={
                  isComposerApprovalState
                    ? (activePendingApproval?.detail ?? "Resolve this approval request to continue")
                    : activePendingProgress
                      ? isChoiceOnlyPendingQuestion
                        ? "Choose an option above"
                        : "Type your own answer, or leave this blank to use the selected option"
                      : showPlanFollowUpPrompt && activeProposedPlan
                        ? "Add feedback to refine the plan, or leave this blank to implement it"
                        : projectSelectionRequired
                          ? "Choose a project above to start a thread"
                          : noProviderAvailable
                            ? "Enable a provider in Settings to send a message"
                            : hasExternalSendableContent
                              ? "Optional overall note…"
                              : phase === "disconnected"
                                ? "Ask for follow-up changes or attach images"
                                : "Ask anything, @tag files/folders, $use skills, or / for commands"
                }
                disabled={
                  isConnecting ||
                  isComposerApprovalState ||
                  projectSelectionRequired ||
                  isChoiceOnlyPendingQuestion
                }
              />
              {showMobilePendingAnswerActions ? (
                <div
                  data-chat-composer-mobile-pending-actions="true"
                  className="absolute bottom-0 right-0 flex justify-end"
                >
                  <ComposerPrimaryActions
                    compact
                    pendingAction={pendingPrimaryAction}
                    isRunning={false}
                    showPlanFollowUpPrompt={false}
                    promptHasText={false}
                    isSendBusy={isSendBusy}
                    sendDisabledReason={sendDisabledReason}
                    isConnecting={isConnecting}
                    isEnvironmentUnavailable={
                      environmentUnavailable !== null ||
                      noProviderAvailable ||
                      projectSelectionRequired
                    }
                    isPreparingWorktree={false}
                    hasSendableContent={false}
                    preserveComposerFocusOnPointerDown
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryAction}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                  />
                </div>
              ) : null}
            </div>
          </div>

          <ComposerPromptLengthValidation
            message={providerInputSubmissionError ?? composerSubmissionError}
          />

          {/* Bottom toolbar */}
          {isComposerCollapsedMobile || isComposerApprovalState ? null : (
            <div
              data-chat-composer-footer="true"
              data-chat-composer-footer-compact={isComposerFooterCompact ? "true" : "false"}
              className={cn(
                "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4",
                pendingUserInputs.length > 0 && "pt-2",
                isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                showMobilePendingAnswerActions && "hidden sm:flex",
              )}
            >
              <div className="-m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {noProviderAvailable ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled
                    data-chat-provider-unavailable="true"
                    className="shrink-0 gap-2 px-2 text-secondary-label sm:px-3"
                  >
                    <CircleAlertIcon className="size-4" />
                    No provider available
                  </Button>
                ) : (
                  <ProviderModelPicker
                    compact={isComposerFooterCompact}
                    activeInstanceId={selectedInstanceId}
                    model={selectedModelForPickerWithCustomFallback}
                    lockedProvider={lockedProvider}
                    lockedContinuationGroupKey={lockedContinuationGroupKey}
                    instanceEntries={providerInstanceEntries}
                    keybindings={keybindings}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerClassName="-ms-2.5"
                    terminalOpen={terminalOpen}
                    open={isComposerModelPickerOpen}
                    {...(composerProviderState.modelPickerIconClassName
                      ? {
                          activeProviderIconClassName:
                            composerProviderState.modelPickerIconClassName,
                        }
                      : {})}
                    onOpenChange={(open) => {
                      setIsComposerModelPickerOpen(open);
                    }}
                    getModelDisabledReason={getModelDisabledReason}
                    onInstanceModelChange={onProviderModelSelect}
                  />
                )}

                {isComposerFooterCompact ? (
                  <CompactComposerControlsMenu
                    interactionMode={interactionMode}
                    runtimeMode={runtimeMode}
                    showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                    traitsMenuContent={providerTraitsMenuContent}
                    onToggleInteractionMode={toggleInteractionMode}
                    onRuntimeModeChange={handleRuntimeModeChange}
                  />
                ) : (
                  <>
                    {providerTraitsPicker ? (
                      <>
                        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                        {providerTraitsPicker}
                      </>
                    ) : null}
                    <ComposerFooterModeControls
                      showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                      interactionMode={interactionMode}
                      runtimeMode={runtimeMode}
                      onToggleInteractionMode={toggleInteractionMode}
                      onRuntimeModeChange={handleRuntimeModeChange}
                    />
                  </>
                )}
              </div>

              {/* Right side: send / stop button */}
              <div
                data-chat-composer-actions="right"
                data-chat-composer-primary-actions-compact={
                  isComposerPrimaryActionsCompact ? "true" : "false"
                }
                className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
              >
                {inlineEdit !== undefined ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={inlineEdit.isSubmitting}
                    onClick={inlineEdit.onCancel}
                  >
                    Cancel
                  </Button>
                ) : null}
                <ComposerFooterPrimaryActions
                  compact={isComposerPrimaryActionsCompact}
                  selectedProvider={selectedProvider}
                  selectedModel={selectedModel}
                  activeContextWindow={
                    settings.contextWindowMeterEnabled ? activeContextWindow : null
                  }
                  activeUsageLimits={activeUsageLimits}
                  activeThreadModelDisplayName={activeThreadModelDisplayName}
                  pendingAction={pendingPrimaryAction}
                  isRunning={phase === "running"}
                  canPauseTurn={canPauseTurn}
                  canResumeInterruptedTurn={canResumeInterruptedTurn}
                  showPlanFollowUpPrompt={pendingUserInputs.length === 0 && showPlanFollowUpPrompt}
                  promptHasText={prompt.trim().length > 0}
                  isSendBusy={isSendBusy}
                  sendDisabledReason={sendDisabledReason}
                  isConnecting={isConnecting}
                  isEnvironmentUnavailable={
                    environmentUnavailable !== null ||
                    noProviderAvailable ||
                    projectSelectionRequired
                  }
                  isPreparingWorktree={isPreparingWorktree}
                  hasSendableContent={hasSendableContent}
                  preserveComposerFocusOnPointerDown={isMobileViewport}
                  showSendWhileRunning={isMobileViewport}
                  showSecondaryStatus={!isComposerResting}
                  onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                  onInterrupt={handleInterruptPrimaryAction}
                  onResumeInterruptedTurn={onResumeInterruptedTurn}
                  onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                  compactDisabled={
                    compactDisabled || noProviderAvailable || isSendBusy || isConnecting
                  }
                  compactDisabledReason={resolvedCompactDisabledReason}
                  {...(selectedProvider === "claudeAgent"
                    ? { onCompactContext: compactThreadContext }
                    : {})}
                />
              </div>
            </div>
          )}
        </div>
      </ComposerSurface.Main>
    </form>
  );
});
