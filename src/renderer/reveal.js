/* Complete a requested native smooth scroll across DOM replacement. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IssuemonReveal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function create({ requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame } = {}) {
    let frame = null, getRow = null, previousRow = null, previousHeight = null, previousWidth = null, unlisten = null;
    const cancel = () => {
      if (frame !== null) cancelFrame(frame);
      frame = getRow = previousRow = null;
      unlisten?.();
      unlisten = null;
    };

    // A render removes the old scrolling element and its animation. Resolve the
    // current row after rendering/resizing, without polling unreachable geometry.
    function refresh() {
      if (!getRow) return;
      if (frame !== null) cancelFrame(frame);
      frame = requestFrame(() => {
        frame = null;
        const row = getRow(), list = row?.closest('[data-scroll-key="rows"]');
        if (!list) return cancel(); // selection/view changed, or the row disappeared
        const r = row.getBoundingClientRect(), box = list.getBoundingClientRect();
        if (!r.height || !box.height) return cancel(); // hidden in the narrow detail layout
        const visible = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
        if (previousRow && visible >= Math.min(r.height, box.height) - 1) return cancel();
        if (row !== previousRow || box.height !== previousHeight || box.width !== previousWidth) {
          unlisten?.();
          const ended = () => { if (getRow?.() === row) cancel(); };
          list.addEventListener('scrollend', ended);
          unlisten = () => list.removeEventListener('scrollend', ended);
          previousRow = row;
          previousHeight = box.height;
          previousWidth = box.width;
          row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      });
    }

    function reveal(resolveRow) {
      cancel();
      getRow = resolveRow;
      refresh();
    }

    return { reveal, refresh, cancel };
  }

  return { create };
});
