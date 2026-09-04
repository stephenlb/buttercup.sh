/* ═══════════════════════════════════════════════════════════════════════════
   signup — the one piece of script these documents carry.

   The POST goes to the mailing-list vendor in a hidden frame, so the page stays
   put and we never see the response — cross-origin. The receipt is therefore
   "sent", not "accepted", which is honest: the confirmation email is what
   actually confirms. Same behaviour as the harness (js/main.js), kept separate
   because updates/ is plain documents and loads none of the harness.
   ═══════════════════════════════════════════════════════════════════════════ */
document.querySelectorAll("form.signup").forEach((form) => {
  // A password manager that fills the honeypot would get a real person
  // rejected, so it starts every load empty no matter what restored it.
  form.elements.email_address_check.value = "";
  form.addEventListener("submit", (e) => {
    // Filled means a script filled it. Swallow the submit and show the same
    // receipt a person gets: nothing reaches the vendor, and nothing tells the
    // bot which field gave it away.
    if (form.elements.email_address_check.value) e.preventDefault();
    form.dataset.sent = "1";
  });
});
