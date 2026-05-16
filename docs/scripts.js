/* ────────────────────────────────────────────────────────────────────────
 * arch-graph landing — interactive layer
 * Zero deps. Vanilla JS.
 *  - IntersectionObserver fade-in for .reveal elements
 *  - copy-to-clipboard on .code-block
 * ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const prefersReducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  // ────────────────────────────────────────────────── REVEAL
  function setupReveal() {
    const items = document.querySelectorAll('.reveal');
    if (items.length === 0) return;

    if (prefersReducedMotion || !('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('is-visible'));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -80px 0px', threshold: 0.08 }
    );

    items.forEach((el) => io.observe(el));
  }

  // ────────────────────────────────────────────────── COPY
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      /* fall through */
    }
    // Legacy fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  function setupCopyButtons() {
    document.querySelectorAll('.code-block').forEach((block) => {
      const btn = block.querySelector('.copy-btn');
      const code = block.querySelector('pre code, pre');
      if (!btn || !code) return;

      btn.addEventListener('click', async () => {
        const text = code.textContent || '';
        const ok = await copyText(text.trim());
        const original = btn.textContent;
        btn.textContent = ok ? 'Copied' : 'Failed';
        btn.classList.toggle('copied', ok);
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  }

  // ────────────────────────────────────────────────── INIT
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setupReveal();
      setupCopyButtons();
    });
  } else {
    setupReveal();
    setupCopyButtons();
  }
})();
