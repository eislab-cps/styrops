// modal.mjs — the two overlays (SLAM map, example questions) share one shell:
// a dimmed backdrop, a card, and three ways out (X, backdrop, Esc).
//
// The markup lives in index.html next to the other overlays; this only owns the
// open/close behaviour so both modals feel identical.

export class Modal {
  /** @param {string} sel  selector of a `.modal` element */
  constructor(sel, hooks = {}) {
    this.el = document.querySelector(sel);
    this.hooks = hooks;
    this.open = false;
    if (!this.el) return;

    this.card = this.el.querySelector('.modal-card');
    this.el.addEventListener('click', (ev) => {
      // backdrop OR the X; anything inside the card is left alone
      if (ev.target.closest('[data-close]') || !ev.target.closest('.modal-card')) this.hide();
    });
    // capture, so Esc closes the modal before main.mjs clears the obstacle pick
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.open) { ev.stopPropagation(); this.hide(); }
    }, true);
  }

  show() {
    if (!this.el || this.open) return;
    this.open = true;
    this.el.hidden = false;
    // one frame later so the CSS transition has a "from" state to run out of
    requestAnimationFrame(() => this.el.classList.add('on'));
    document.body.classList.add('modal-open');
    this.hooks.onShow?.();
  }

  hide() {
    if (!this.el || !this.open) return;
    this.open = false;
    this.el.classList.remove('on');
    document.body.classList.remove('modal-open');
    this.hooks.onHide?.();
    // keep it in the layout until the fade finishes, then take it out of the
    // tab order entirely
    clearTimeout(this._t);
    this._t = setTimeout(() => { if (!this.open) this.el.hidden = true; }, 220);
  }

  toggle() { this.open ? this.hide() : this.show(); }
}
