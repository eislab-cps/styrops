// tutorial.mjs — the "?" in the chat header: what you can actually ask Moa.
//
// Every question is click-to-ask. Logged in, it fills the composer and sends;
// logged out there is nobody to send it to, so the overlay steps aside and puts
// the cursor in the connect card instead.

import { Modal } from './modal.mjs';

export const GROUPS = [
  {
    name: 'Operate',
    hint: 'tell her what to do',
    items: ['Mow the back lawn', 'Stop and go charge'],
  },
  {
    name: 'Weather',
    hint: 'she plans around it',
    items: ['Should I mow today given the weather?', 'Have you seen the weather report?'],
  },
  {
    name: 'Diagnose',
    hint: 'when something is off',
    items: [
      'Why are you stuck?',
      'What happened out there? Check your logs',
      'How are your blades doing?',
      'Where do you keep getting stuck? Check your logs and suggest improvements.',
    ],
  },
  {
    name: 'Quality',
    hint: 'how the lawn looks',
    items: ['Is the lawn well cut?', 'Which zone looks worst?'],
  },
  {
    name: 'Advanced',
    hint: 'under the hood',
    items: ['Switch to the lines algorithm', 'What do your sensors see right now?'],
  },
];

export class Tutorial {
  /** @param chat Chat — owns the composer and the login state */
  constructor(chat) {
    this.chat = chat;
    this.modal = new Modal('#tut-modal', { onShow: () => this.sync() });
    this.body = document.querySelector('#tut-body');
    this.foot = document.querySelector('#tut-foot');
    this.build();

    const btn = document.querySelector('#chat-help');
    if (btn) btn.addEventListener('click', () => this.modal.toggle());
  }

  open() { this.modal.show(); }
  close() { this.modal.hide(); }

  build() {
    if (!this.body) return;
    this.body.innerHTML = '';
    for (const g of GROUPS) {
      const sec = document.createElement('section');
      sec.className = 'tut-group';
      const h = document.createElement('h4');
      h.innerHTML = `${g.name}<small>${g.hint}</small>`;
      sec.appendChild(h);
      for (const q of g.items) {
        const b = document.createElement('button');
        b.className = 'tut-q';
        b.type = 'button';
        b.textContent = q;
        b.addEventListener('click', () => this.ask(q));
        sec.appendChild(b);
      }
      this.body.appendChild(sec);
    }
  }

  /** Footer copy depends on whether there is an agent to talk to. */
  sync() {
    if (!this.foot) return;
    this.foot.textContent = this.chat && this.chat.client
      ? 'Moa answers in the chat panel — the overlay closes as she starts.'
      : 'Connect with your colony key first — clicking a question takes you there.';
    this.foot.classList.toggle('warn', !(this.chat && this.chat.client));
  }

  ask(text) {
    this.modal.hide();
    if (this.chat && this.chat.ask(text)) return;
    this.chat?.focusConnect();
  }
}
