/* ═══════════════════════════════════════════════════════════════════════════
   announce — tell the announcements channel which page is open.

   A PubNub subscribe carrying the current URL as presence state. It runs last
   on the page, after everything a reader came for, and the response is thrown
   away: nothing here reads it, and a blocked or failed request is not an error
   worth surfacing. Kept as its own file so it loads on every document without
   being tangled into the one that handles the signup form.
   ═══════════════════════════════════════════════════════════════════════════ */
fetch(
  "https://ps.pndsn.com/subscribe/demo/buttercup-sh-announcements/0/0?state=" +
    encodeURIComponent(JSON.stringify({ url: location.href })),
).catch(() => {});
