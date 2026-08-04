import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FocusEvent,
  type MouseEvent,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

interface ActionMenuTriggerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  expanded?: boolean;
  tooltip?: string;
}

function VerticalEllipsisIcon() {
  return (
    <svg
      className="action-menu-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="8" cy="3" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="8" cy="13" r="1.5" />
    </svg>
  );
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') ref(node);
      else ref.current = node;
    }
  };
}

export const ActionMenuTrigger = forwardRef<HTMLButtonElement, ActionMenuTriggerProps>(
  function ActionMenuTrigger(
    {
      label,
      expanded = false,
      tooltip,
      className,
      disabled,
      onMouseEnter,
      onMouseLeave,
      onFocus,
      onBlur,
      ...props
    },
    ref
  ) {
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [showTooltip, setShowTooltip] = useState(false);
    const [tooltipStyle, setTooltipStyle] = useState<{ top: number; left: number }>({
      top: 0,
      left: 0,
    });
    const tooltipText = tooltip ?? label;
    const classes = ['task-tree-move-trigger', className].filter(Boolean).join(' ');

    const updateTooltipPosition = useCallback(() => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      setTooltipStyle({
        top: rect.top + rect.height / 2,
        left: rect.right + 6,
      });
    }, []);

    const openTooltip = () => {
      if (disabled || expanded) return;
      updateTooltipPosition();
      setShowTooltip(true);
    };

    const closeTooltip = () => {
      setShowTooltip(false);
    };

    useEffect(() => {
      if (expanded) {
        setShowTooltip(false);
      }
    }, [expanded]);

    useEffect(() => {
      if (!showTooltip) return;
      const handleScroll = () => setShowTooltip(false);
      window.addEventListener('scroll', handleScroll, true);
      window.addEventListener('resize', handleScroll);
      return () => {
        window.removeEventListener('scroll', handleScroll, true);
        window.removeEventListener('resize', handleScroll);
      };
    }, [showTooltip]);

    const handleMouseEnter = (event: MouseEvent<HTMLButtonElement>) => {
      openTooltip();
      onMouseEnter?.(event);
    };

    const handleMouseLeave = (event: MouseEvent<HTMLButtonElement>) => {
      closeTooltip();
      onMouseLeave?.(event);
    };

    const handleFocus = (event: FocusEvent<HTMLButtonElement>) => {
      openTooltip();
      onFocus?.(event);
    };

    const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
      closeTooltip();
      onBlur?.(event);
    };

    return (
      <>
        <button
          ref={mergeRefs(buttonRef, ref)}
          type="button"
          className={classes}
          aria-label={label}
          aria-expanded={expanded}
          aria-haspopup="menu"
          disabled={disabled}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onFocus={handleFocus}
          onBlur={handleBlur}
          {...props}
        >
          <VerticalEllipsisIcon />
        </button>
        {showTooltip &&
          !disabled &&
          createPortal(
            <span
              className="action-menu-tooltip action-menu-tooltip--floating"
              role="tooltip"
              style={{ top: tooltipStyle.top, left: tooltipStyle.left }}
            >
              {tooltipText}
            </span>,
            document.body
          )}
      </>
    );
  }
);
