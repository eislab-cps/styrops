// icons.mjs — inline SVG glyph set.
//
// Deliberately NOT emoji: a sales demo must not risk tofu boxes on a machine
// without a colour-emoji font (many Linux laptops ship without one). Every
// glyph here is self-contained markup, no font and no network dependency.

const s = (body, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

// ---- obstacle palette --------------------------------------------------------
export const OBSTACLE_ICON = {
  rock: s(`<path d="M2.5 18.5 6 9.2 11 5.2l6.2 2L21.5 14l-1.6 4.5z" fill="#8d949c"/>
           <path d="M11 5.2 6 9.2l3 9.3h8.6L14 6.8z" fill="#c3cad2" opacity=".5"/>
           <path d="M2.5 18.5h19" stroke="#6b7178" stroke-width="1.1"/>`),
  tree: s(`<rect x="10.7" y="13" width="2.7" height="8.2" rx=".9" fill="#6b4a2c"/>
           <circle cx="12" cy="8.6" r="5.9" fill="#3d8c43"/>
           <circle cx="8.3" cy="11.4" r="3.7" fill="#2f7538"/>
           <circle cx="15.7" cy="11.1" r="3.5" fill="#4ca755"/>`),
  trampoline: s(`<ellipse cx="12" cy="9.6" rx="9" ry="4.2" fill="#16224f" stroke="#3f63d6" stroke-width="1.5"/>
           <path d="M4.2 11.6 2.6 20M19.8 11.6 21.4 20M9 13.4 7.9 20M15 13.4 16.1 20"
                 stroke="#3f63d6" stroke-width="1.5" stroke-linecap="round" fill="none"/>`),
  toy: s(`<circle cx="12" cy="12" r="8.6" fill="#ef3b3b"/>
          <path d="M12 4.4l3.7 2.7-1.4 4.4H9.7L8.3 7.1z" fill="#fff" opacity=".9"/>
          <path d="M12 20.6a8.6 8.6 0 0 0 6.1-2.5l-2.5-1.6-3.6 1.2z" fill="#fff" opacity=".55"/>`),
  flowerbed: s(`<ellipse cx="12" cy="16.6" rx="9" ry="4.4" fill="#5a4028"/>
          <path d="M7.5 12.6v4M12 10.4v6.2M16.5 12.8v3.8" stroke="#3f7a3d" stroke-width="1.3"/>
          <circle cx="7.5" cy="11.6" r="2.1" fill="#ff5fa2"/>
          <circle cx="12" cy="9.2" r="2.3" fill="#ffd23f"/>
          <circle cx="16.5" cy="11.9" r="2.1" fill="#a06cff"/>`),
  hedgehog: s(`<path d="M2.8 18.2c0-4.6 3.8-8.4 8.4-8.4s8.4 3.8 8.4 8.4z" fill="#6b4a30"/>
          <path d="M19.6 18.2c1.7 0 2.6-1.1 2.6-1.1l-3.1-1z" fill="#402b1b"/>
          <path d="M5.6 10.9 4.2 7.7M9.2 8.9 8.6 5.5M12.9 8.7l1.1-3.3M16.3 10.2l2.3-2.6"
                stroke="#3a2a1c" stroke-width="1.6" stroke-linecap="round"/>
          <circle cx="19.2" cy="16.2" r=".8" fill="#141414"/>`),
};

// ---- weather -----------------------------------------------------------------
export const WEATHER_ICON = {
  sunny: s(`<circle cx="12" cy="12" r="4.7" fill="#ffcf5c"/>
            <g stroke="#ffcf5c" stroke-width="1.9" stroke-linecap="round">
              <path d="M12 2.4v2.5M12 19.1v2.5M2.4 12h2.5M19.1 12h2.5M5.2 5.2l1.8 1.8M17 17l1.8 1.8M18.8 5.2 17 7M7 17l-1.8 1.8"/>
            </g>`),
  cloudy: s(`<circle cx="9.2" cy="8.2" r="3.7" fill="#ffcf5c"/>
             <path d="M7.4 19.4a4.1 4.1 0 0 1 .3-8.2 5.3 5.3 0 0 1 10 1.3 3.5 3.5 0 0 1-.6 6.9z" fill="#c3cdd8"/>`),
  rain: s(`<path d="M7.4 15.2a4.1 4.1 0 0 1 .3-8.2 5.3 5.3 0 0 1 10 1.3 3.5 3.5 0 0 1-.6 6.9z" fill="#94a3b4"/>
           <g stroke="#6cc8ff" stroke-width="1.8" stroke-linecap="round">
             <path d="M8.2 17.4 7 20.8M12.2 17.4 11 20.8M16.2 17.4 15 20.8"/>
           </g>`),
  storm: s(`<path d="M7.4 14.2a4.1 4.1 0 0 1 .3-8.2 5.3 5.3 0 0 1 10 1.3 3.5 3.5 0 0 1-.6 6.9z" fill="#7f8d9c"/>
            <path d="M13.2 13 8.6 19.4h3.1L9.9 23.2l5.6-6.9h-3.1l1.9-3.3z" fill="#ffd23f"/>`),
};

// ---- toast / status glyphs ---------------------------------------------------
export const ICON = {
  warn: s(`<path d="M12 2.6 22 20.4H2z" fill="#fbbf24"/>
           <path d="M12 8.8v5.4M12 16.6v1.5" stroke="#2a1f05" stroke-width="2" stroke-linecap="round"/>`),
  bad: s(`<circle cx="12" cy="12" r="9.2" fill="#f87171"/>
          <path d="M8.7 8.7 15.3 15.3M15.3 8.7 8.7 15.3" stroke="#2c0c0c" stroke-width="2.1" stroke-linecap="round"/>`),
  ok: s(`<circle cx="12" cy="12" r="9.2" fill="#34d399"/>
         <path d="M7.8 12.4 10.7 15.3 16.3 9.2" stroke="#05281c" stroke-width="2.3" fill="none"
               stroke-linecap="round" stroke-linejoin="round"/>`),
  info: s(`<circle cx="12" cy="12" r="9.2" fill="#7dd3fc"/>
           <path d="M12 7.2v.3M12 10.8v6" stroke="#052033" stroke-width="2.1" stroke-linecap="round"/>`),
  party: s(`<path d="M11 1.8 13 8l6.2 2L13 12l-2 6.2L9 12 2.8 10 9 8z" fill="#ff8a3d"/>
            <path d="M18.4 14.6l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z" fill="#ffd23f"/>`),
  play: s(`<circle cx="12" cy="12" r="9.2" fill="#34d399"/><path d="M10 8.2 16 12l-6 3.8z" fill="#05281c"/>`),
  dock: s(`<path d="M12 3 21.4 11.2h-2.7V20.6h-4.2v-5.5h-4.4v5.5H5.9V11.2H2.6z" fill="#34d399"/>`),
  battery: s(`<rect x="1.9" y="6.8" width="17" height="10.4" rx="2.6" fill="none" stroke="#f87171" stroke-width="1.9"/>
              <rect x="4.2" y="9.1" width="4.2" height="5.8" rx="1.1" fill="#f87171"/>
              <path d="M20.3 10.2h1a1 1 0 0 1 1 1v1.6a1 1 0 0 1-1 1h-1z" fill="#f87171"/>`),
  reconnect: s(`<path d="M20.4 12a8.4 8.4 0 1 1-2.7-6.2" fill="none" stroke="#34d399" stroke-width="2.1" stroke-linecap="round"/>
                <path d="M20.6 2.8v5h-5z" fill="#34d399"/>`),
  reset: s(`<path d="M3.6 12a8.4 8.4 0 1 0 2.7-6.2" fill="none" stroke="#34d399" stroke-width="2.1" stroke-linecap="round"/>
            <path d="M3.4 2.8v5h5z" fill="#34d399"/>`),
  plus: s(`<circle cx="12" cy="12" r="9.2" fill="#34d399"/>
           <path d="M12 7.6v8.8M7.6 12h8.8" stroke="#05281c" stroke-width="2.3" stroke-linecap="round"/>`),
  brain: s(`<circle cx="12" cy="12" r="9.2" fill="#a78bfa"/>
            <path d="M9 8.4c2 -1.4 4 -1.4 6 0M8 12h8M9.4 15.6c1.8 1.2 3.4 1.2 5.2 0"
                  stroke="#180c33" stroke-width="1.8" fill="none" stroke-linecap="round"/>`),
  bolt: s(`<path d="M13.4 1.6 4.8 13.4h5.3L9 22.4l9-12.2h-5.6z" fill="currentColor"/>`),
  blade: s(`<circle cx="12" cy="12" r="2.5" fill="currentColor"/>
            <path d="M11.1 9.6 3.4 6.9c-.6-.2-.6-1 0-1.3l7.4-2.9c.6-.2 1.2.3 1.1.9l-.3 5.6a.9.9 0 0 1-.5.4z"
                  fill="currentColor" opacity=".82"/>
            <path d="M13.6 13.4l7.2 3.6c.6.3.4 1.1-.2 1.3l-7.7 1.9c-.6.1-1.1-.4-1-1l.8-5.4a.9.9 0 0 1 .9-.4z"
                  fill="currentColor" opacity=".82"/>`),
  sprout: s(`<path d="M12 21.4v-8.2" stroke="#4ade80" stroke-width="2.1" stroke-linecap="round" fill="none"/>
             <path d="M12 14.6C12 11 9.4 8.2 5.4 7.8c-.4 4 2.3 6.9 6.6 6.8" fill="#34d399"/>
             <path d="M12 12.8c0-3.4 2.5-6.1 6.3-6.5.4 3.8-2.2 6.6-6.3 6.5" fill="#4ade80"/>
             <path d="M8.2 21.6h7.6" stroke="#6b4a30" stroke-width="2.2" stroke-linecap="round" fill="none"/>`),
  send: s(`<path d="M2 10 18 3l-4.2 7L18 17z" fill="currentColor"/>`, '0 0 20 20'),
  spark: s(`<path d="M12 2.4 14 8.6l6.2 2-6.2 2-2 6.2-2-6.2-6.2-2 6.2-2z" fill="currentColor"/>`),
  gear: s(`<path d="M12 8.2A3.8 3.8 0 1 0 12 15.8 3.8 3.8 0 0 0 12 8.2m0 2.1a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4"
                 fill="currentColor"/>
           <path d="M10.6 1.8h2.8l.4 2.6 2 .9 2.2-1.5 2 2-1.5 2.2.9 2 2.6.4v2.8l-2.6.4-.9 2 1.5 2.2-2 2-2.2-1.5-2 .9-.4 2.6h-2.8l-.4-2.6-2-.9-2.2 1.5-2-2 1.5-2.2-.9-2-2.6-.4v-2.8l2.6-.4.9-2L3 5.8l2-2 2.2 1.5 2-.9z"
                 fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>`),
};
