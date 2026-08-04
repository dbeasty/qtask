import { useEffect, type RefObject } from 'react';

function isInsideMenuTree(
  node: Node,
  menuRef: RefObject<HTMLElement | null>,
  anchorRef: RefObject<HTMLElement | null>
): boolean {
  return Boolean(menuRef.current?.contains(node) || anchorRef.current?.contains(node));
}

export function useDismissibleMenu(
  menuRef: RefObject<HTMLElement | null>,
  anchorRef: RefObject<HTMLElement | null>,
  onClose: () => void
) {
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (isInsideMenuTree(target, menuRef, anchorRef)) return;
      if (
        event.composedPath().some(
          (node) => node instanceof Node && isInsideMenuTree(node, menuRef, anchorRef)
        )
      ) {
        return;
      }
      onClose();
    };

    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchorRef, menuRef, onClose]);
}
