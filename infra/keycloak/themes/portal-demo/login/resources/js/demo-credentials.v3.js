/* SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Lists the shared tester accounts on the public demo's sign-in
 * screen, with a button per role that fills the form.
 *
 * Injected rather than shipped as a login.ftl override on purpose.
 * Overriding the template means vendoring Keycloak 26's FreeMarker
 * and re-vendoring it on every upgrade; this file touches nothing the
 * parent theme owns, so a Keycloak bump cannot silently break the
 * login page. Worst case the panel stops appearing and the form
 * behaves exactly as it does today.
 *
 * Only ever loaded by the `portal-demo` theme. A deployment using
 * `portal` never sees it.
 */
(function () {
  'use strict';

  // Mirrors seed-test-users.sh and the landing-page banner in
  // apps/portal-web/src/app/public-landing.tsx. Keep the three in
  // step: these are the accounts gg-reset-demo.timer restores nightly.
  var ACCOUNTS = [
    { role: 'Admin', user: 'tester-admin', pass: 'Admin123!' },
    { role: 'Contributor', user: 'tester-contributor', pass: 'Contributor123!' },
    { role: 'Viewer', user: 'tester-viewer', pass: 'Viewer123!' },
  ];

  function build() {
    var form = document.querySelector('#kc-form-login');
    var username = document.querySelector('#username');
    var password = document.querySelector('#password');

    // Only the username + password step. Other flows this theme also
    // covers (password reset, required actions, consent) have no
    // credential fields and must be left alone.
    if (!form || !username || !password) return;
    if (document.querySelector('.gg-demo')) return;

    var panel = document.createElement('div');
    panel.className = 'gg-demo';

    var h = document.createElement('h2');
    h.textContent = 'Public test instance';
    panel.appendChild(h);

    var p = document.createElement('p');
    p.textContent =
      'Sign in with any of the shared accounts below. Everything you '
      + 'create is wiped and restored to a curated sample every day at '
      + '04:00 UTC.';
    panel.appendChild(p);

    ACCOUNTS.forEach(function (acct) {
      var row = document.createElement('div');
      row.className = 'gg-demo-row';

      var role = document.createElement('span');
      role.className = 'gg-demo-role';
      role.textContent = acct.role;

      var cred = document.createElement('span');
      cred.className = 'gg-demo-cred';
      // Shown as well as fillable: a visitor on a password manager, or
      // one who wants to type it into a second browser, still needs to
      // be able to read it.
      cred.textContent = acct.user + ' / ' + acct.pass;

      var fill = document.createElement('button');
      fill.className = 'gg-demo-fill';
      fill.type = 'button'; // never submit the form by accident
      fill.textContent = 'Use';
      fill.addEventListener('click', function () {
        username.value = acct.user;
        password.value = acct.pass;
        // React-free page, but Keycloak's own validation listens for
        // input events; dispatching keeps any such handler in sync.
        [username, password].forEach(function (el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        Array.prototype.forEach.call(
          document.querySelectorAll('.gg-demo-fill'),
          function (b) { b.removeAttribute('data-filled'); }
        );
        fill.setAttribute('data-filled', '1');
        // Leave the final click to the visitor: filling and submitting
        // in one gesture reads as the page logging itself in.
        var submit = form.querySelector('input[type="submit"], button[type="submit"]');
        if (submit && submit.focus) submit.focus();
      });

      row.appendChild(role);
      row.appendChild(cred);
      row.appendChild(fill);
      panel.appendChild(row);
    });

    // Inside the card, appended after the form.
    //
    // The first attempt put the panel after the card as a sibling, on
    // the theory that staying out of the card's internals was safer.
    // It was not: PatternFly 5 lays .pf-v5-c-login__container out as a
    // two-column grid on wide viewports, so the panel landed in the
    // second cell beside the card and half of it slid underneath.
    // Appending inside the card's main column keeps it in normal
    // document flow, so it simply sits below the Sign In button and
    // the card grows to fit.
    // Preferred home is .pf-v5-c-login__main-body, the element that
    // carries the card's horizontal padding. Appending to
    // .pf-v5-c-login__main instead (the first fix) put the panel in
    // normal flow but outside that padding, so the text ran flush to
    // both edges of the card. Landing in the body means the panel
    // lines up with the form fields for free, with no padding value
    // of ours to keep in step with PatternFly's.
    var body = form.closest('.pf-v5-c-login__main-body');
    var card = form.closest('.pf-v5-c-login__main');
    if (body) {
      body.appendChild(panel);
    } else if (card) {
      card.appendChild(panel);
    } else {
      // Heavily customised parent theme: right after the form, which
      // is inside whatever container holds it.
      form.parentElement.insertBefore(panel, form.nextSibling);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
