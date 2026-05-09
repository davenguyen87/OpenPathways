/*
 * Prism widget: Carousel
 * APG pattern: Carousel (Tabbed) — manual, no autoplay
 * Keyboard model:
 *   Prev / Next buttons receive focus naturally (Tab).
 *   Enter / Space  - activate the focused control button
 *   ArrowLeft      - move to previous slide (when focus is on a control)
 *   ArrowRight     - move to next slide (when focus is on a control)
 *   Home           - first slide (when focus is on a control)
 *   End            - last slide (when focus is on a control)
 * No autoplay. No focus traps. Idempotent via data-prism-registered.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') {
    return;
  }
  var ns = (window.PrismWidgets = window.PrismWidgets || {});

  function getSlides(root) {
    return Array.prototype.slice.call(
      root.querySelectorAll('[data-prism-slide]')
    );
  }

  function show(root, index) {
    var slides = getSlides(root);
    if (!slides.length) return;
    if (index < 0) index = 0;
    if (index >= slides.length) index = slides.length - 1;
    for (var i = 0; i < slides.length; i++) {
      if (i === index) {
        slides[i].removeAttribute('hidden');
      } else {
        slides[i].setAttribute('hidden', '');
      }
    }
    var status = root.querySelector('[data-prism-status]');
    if (status) {
      status.textContent = 'Slide ' + (index + 1) + ' of ' + slides.length;
    }
    var prev = root.querySelector('[data-prism-prev]');
    var next = root.querySelector('[data-prism-next]');
    if (prev) {
      if (index === 0) {
        prev.setAttribute('disabled', '');
      } else {
        prev.removeAttribute('disabled');
      }
    }
    if (next) {
      if (index === slides.length - 1) {
        next.setAttribute('disabled', '');
      } else {
        next.removeAttribute('disabled');
      }
    }
    root.setAttribute('data-prism-current', String(index));
  }

  function currentIndex(root) {
    var attr = root.getAttribute('data-prism-current');
    var n = attr === null ? 0 : parseInt(attr, 10);
    if (isNaN(n)) n = 0;
    return n;
  }

  function registerCarousel(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.getAttribute('data-prism-registered') === '1') return;
    root.setAttribute('data-prism-registered', '1');

    var slides = getSlides(root);
    if (!slides.length) return;

    show(root, 0);

    var prev = root.querySelector('[data-prism-prev]');
    var next = root.querySelector('[data-prism-next]');

    if (prev) {
      prev.addEventListener('click', function (event) {
        event.preventDefault();
        show(root, currentIndex(root) - 1);
      });
    }
    if (next) {
      next.addEventListener('click', function (event) {
        event.preventDefault();
        show(root, currentIndex(root) + 1);
      });
    }

    function onKeydown(event) {
      var key = event.key;
      var slidesLen = getSlides(root).length;
      if (key === 'ArrowRight') {
        event.preventDefault();
        show(root, currentIndex(root) + 1);
      } else if (key === 'ArrowLeft') {
        event.preventDefault();
        show(root, currentIndex(root) - 1);
      } else if (key === 'Home') {
        event.preventDefault();
        show(root, 0);
      } else if (key === 'End') {
        event.preventDefault();
        show(root, slidesLen - 1);
      }
    }
    if (prev) prev.addEventListener('keydown', onKeydown);
    if (next) next.addEventListener('keydown', onKeydown);
  }

  ns.registerCarousel = registerCarousel;

  function autoRegister() {
    var roots = document.querySelectorAll('[data-prism-widget="carousel"]');
    Array.prototype.forEach.call(roots, registerCarousel);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoRegister);
    } else {
      autoRegister();
    }
  }
})();
