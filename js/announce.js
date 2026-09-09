/* ═══════════════════════════════════════════════════════════════════════════
   Announcements Notifications - subscribe to announcments channel.

   A PubNub subscribe for a future feature that will allow notifications to be
   sent on the page. Notifications like updates, announcemetns, alerts.
   ═══════════════════════════════════════════════════════════════════════════ */
fetch(
  "https://ps.pndsn.com/subscribe/demo/buttercup-sh-announcements/0/0?state=" +
    encodeURIComponent(JSON.stringify({ url: location.href })),
).catch(() => {});
