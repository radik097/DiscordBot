for (const button of document.querySelectorAll("[data-password-toggle]")) {
  button.addEventListener("click", () => {
    const targets = String(button.dataset.passwordToggle || "")
      .split(",")
      .map((id) => document.getElementById(id.trim()))
      .filter(Boolean);
    const show = targets.some((input) => input.type === "password");
    for (const input of targets) input.type = show ? "text" : "password";
    button.setAttribute("aria-pressed", String(show));
    button.textContent = show
      ? button.dataset.hideLabel || "Скрыть пароль"
      : button.dataset.showLabel || "Показать пароль";
  });
}

for (const form of document.querySelectorAll("[data-password-form]")) {
  form.addEventListener("submit", async (event) => {
    if (form.dataset.passwordSubmitting === "true") return;
    const save = form.querySelector("[data-save-password]");
    const username = form.querySelector('[autocomplete="username"]');
    const password = form.querySelector('[autocomplete="current-password"], [autocomplete="new-password"]');
    if (!save?.checked || !username?.value || !password?.value) return;
    if (!("PasswordCredential" in window) || !navigator.credentials?.store) return;

    event.preventDefault();
    form.dataset.passwordSubmitting = "true";
    try {
      const credential = new PasswordCredential({ id: username.value, password: password.value });
      await navigator.credentials.store(credential);
    } catch {
      // The browser may decline or not expose its password manager. Normal
      // autocomplete attributes still let it offer saving after navigation.
    }
    HTMLFormElement.prototype.submit.call(form);
  });
}
