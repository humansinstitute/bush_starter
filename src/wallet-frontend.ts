import { cancelInvoiceScan, scanInvoiceOnce } from "./ui/qr-scanner.ts";
import { renderInvoiceToCanvas } from "./ui/qr.ts";

interface ApiError {
  message: string;
}

interface BalanceResponse {
  balance: number;
}

interface MakeInvoiceResponse {
  invoice: string;
  amount: number;
  expiresAt: number;
}

interface PayInvoiceResponse {
  preimage: string;
  feesPaid: number;
}

interface SendEcashResponse {
  cashuToken: string;
  sentAmount: number;
}

interface ServerPubkeyStatus {
  hasServerPubkey: boolean;
  serverPubkey?: string;
}

interface ConfigurePubkeyResponse {
  configured: boolean;
  serverPubkey?: string;
}

interface ClearPubkeyResponse {
  cleared: boolean;
}

const statusLine = document.querySelector<HTMLParagraphElement>("#status-line");
const balanceDisplay = document.querySelector<HTMLSpanElement>("#balance-display");
const makeInvoiceForm = document.querySelector<HTMLFormElement>("#make-invoice-form");
const payInvoiceForm = document.querySelector<HTMLFormElement>("#pay-invoice-form");
const sendEcashForm = document.querySelector<HTMLFormElement>("#send-ecash-form");
const invoiceOutput = document.querySelector<HTMLDivElement>("#invoice-output");
const invoiceString = document.querySelector<HTMLElement>("#invoice-string");
const invoiceQrCanvas = document.querySelector<HTMLCanvasElement>("#invoice-qr");
const copyInvoiceButton = document.querySelector<HTMLButtonElement>("#copy-invoice");
const payInvoiceOutput = document.querySelector<HTMLOutputElement>("#pay-invoice-output");
const sendEcashOutput = document.querySelector<HTMLOutputElement>("#send-ecash-output");
const sendEcashTokenPanel = document.querySelector<HTMLElement>("#send-ecash-token-panel");
const sendEcashTokenField = document.querySelector<HTMLTextAreaElement>("#send-ecash-token");
const copyEcashTokenButton = document.querySelector<HTMLButtonElement>("#copy-ecash-token");
const toastTemplate = document.querySelector<HTMLTemplateElement>("#toast-template");
const scanInvoiceButton = document.querySelector<HTMLButtonElement>("#scan-invoice");
const invoiceScannerPanel = document.querySelector<HTMLElement>("#invoice-scanner-panel");
const scannerCancelButton = document.querySelector<HTMLButtonElement>("#scanner-cancel");
const pubkeyOverlay = document.querySelector<HTMLDivElement>("#pubkey-gate");
const pubkeyForm = document.querySelector<HTMLFormElement>("#pubkey-form");
const pubkeyInput = document.querySelector<HTMLInputElement>("#pubkey-input");
const pubkeySubmit = document.querySelector<HTMLButtonElement>("#pubkey-submit");
const pubkeyHint = document.querySelector<HTMLParagraphElement>("#pubkey-hint");
const pubkeyError = document.querySelector<HTMLOutputElement>("#pubkey-error");
const exitButton = document.querySelector<HTMLButtonElement>("#exit-button");
const exitOverlay = document.querySelector<HTMLDivElement>("#exit-overlay");
const exitConfirmButton = document.querySelector<HTMLButtonElement>("#exit-confirm");
const exitCancelButton = document.querySelector<HTMLButtonElement>("#exit-cancel");
const exitWarning = document.querySelector<HTMLParagraphElement>("#exit-warning");

let balanceIntervalId: number | null = null;
let balanceSyncEnabled = false;

const basePath = (() => {
  const segments = window.location.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  const candidate = segments[0];
  return /^\d+$/.test(candidate) ? `/${candidate}` : "";
})();

async function api<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const resolvedInput =
    typeof input === "string" && input.startsWith("/") ? `${basePath}${input}` : input;

  const response = await fetch(resolvedInput, {
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    ...init,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(payload.message || "Request failed");
  }

  return response.json() as Promise<T>;
}

function showStatus(message: string, isError = false): void {
  if (!statusLine) {
    return;
  }
  statusLine.textContent = message;
  statusLine.style.color = isError ? "var(--signal-error)" : "var(--text-muted)";
}

function showToast(message: string): void {
  if (!toastTemplate) {
    return;
  }
  const fragment = toastTemplate.content.cloneNode(true) as DocumentFragment;
  const toast = fragment.querySelector<HTMLDivElement>(".toast");
  if (!toast) {
    return;
  }
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("fade-out");
    toast.addEventListener(
      "animationend",
      () => {
        toast.remove();
      },
      { once: true }
    );
  }, 1800);
}

function setPubkeyError(message: string | null): void {
  if (!pubkeyError) {
    return;
  }
  pubkeyError.textContent = message ?? "";
}

function setPubkeyFormDisabled(disabled: boolean): void {
  if (pubkeyInput) {
    pubkeyInput.disabled = disabled;
  }
  if (pubkeySubmit) {
    pubkeySubmit.disabled = disabled;
  }
}

function isPubkeyMissingError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.toLowerCase().includes("server pubkey not configured");
}

function handleMissingPubkey(error: unknown): boolean {
  if (!isPubkeyMissingError(error)) {
    return false;
  }
  showPubkeyGate();
  setPubkeyError("Server pubkey required to continue");
  if (pubkeyHint) {
    pubkeyHint.textContent = "Paste your server pubkey to resume.";
  }
  return true;
}

function showPubkeyGate(): void {
  stopBalancePolling();
  if (pubkeyOverlay) {
    pubkeyOverlay.removeAttribute("hidden");
  }
  setPubkeyFormDisabled(false);
  setPubkeyError(null);
  if (pubkeyHint) {
    pubkeyHint.textContent = "Provide the server pubkey to continue.";
  }
  if (pubkeyInput) {
    pubkeyInput.focus();
    if (pubkeyInput.value) {
      pubkeyInput.select();
    }
  }
}

function hidePubkeyGate(): void {
  if (pubkeyOverlay) {
    pubkeyOverlay.setAttribute("hidden", "");
  }
  setPubkeyError(null);
}

function startBalancePolling(): void {
  if (balanceIntervalId !== null) {
    balanceSyncEnabled = true;
    return;
  }
  balanceSyncEnabled = true;
  void updateBalance();
  balanceIntervalId = window.setInterval(() => {
    void updateBalance();
  }, 3000);
}

function stopBalancePolling(): void {
  if (balanceIntervalId !== null) {
    window.clearInterval(balanceIntervalId);
    balanceIntervalId = null;
  }
  balanceSyncEnabled = false;
}

async function bootstrapPubkeyStatus(): Promise<void> {
  if (!pubkeyOverlay) {
    startBalancePolling();
    return;
  }
  try {
    const status = await api<ServerPubkeyStatus>("/api/server-pubkey");
    if (pubkeyInput) {
      pubkeyInput.value = status.serverPubkey ?? "";
    }
    if (status.hasServerPubkey) {
      hidePubkeyGate();
      showStatus("Syncing wallet…");
      startBalancePolling();
      return;
    }
    showPubkeyGate();
    showStatus("Awaiting server pubkey…");
  } catch (error) {
    console.error(error);
    showPubkeyGate();
    setPubkeyError("Unable to verify server status");
    showStatus("Failed to load wallet configuration", true);
  }
}

function setupPubkeyFlow(): void {
  if (!pubkeyForm || !pubkeyInput || !pubkeySubmit) {
    startBalancePolling();
    return;
  }

  pubkeyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const candidate = pubkeyInput.value.trim();
    if (!candidate) {
      setPubkeyError("Server pubkey is required");
      pubkeyInput.focus();
      return;
    }
    setPubkeyError(null);
    setPubkeyFormDisabled(true);
    if (pubkeyHint) {
      pubkeyHint.textContent = "Connecting to server…";
    }
    pubkeySubmit.textContent = "Connecting…";

    try {
      const result = await api<ConfigurePubkeyResponse>("/api/server-pubkey", {
        method: "POST",
        body: JSON.stringify({ serverPubkey: candidate }),
      });
      if (!result.configured) {
        throw new Error("Server pubkey rejected");
      }
      hidePubkeyGate();
      showToast("Wallet linked");
      showStatus("Syncing wallet…");
      startBalancePolling();
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "Failed to configure pubkey";
      setPubkeyError(message || "Failed to configure pubkey");
      showStatus("Server pubkey error", true);
      if (pubkeyHint) {
        pubkeyHint.textContent = "Verify the Cashubash server key and try again.";
      }
      if (pubkeyInput) {
        pubkeyInput.focus();
        pubkeyInput.select();
      }
      return;
    } finally {
      pubkeySubmit.textContent = "Connect";
      setPubkeyFormDisabled(false);
    }
  });

  void bootstrapPubkeyStatus();
}

async function updateBalance(): Promise<void> {
  if (!balanceSyncEnabled) {
    return;
  }
  try {
    const data = await api<BalanceResponse>("/api/balance");
    if (balanceDisplay) {
      balanceDisplay.textContent = `${data.balance.toLocaleString()} sats`;
    }
    showStatus("Balance synced");
  } catch (error) {
    console.error(error);
    if (handleMissingPubkey(error)) {
      return;
    }
    showStatus("Failed to fetch balance", true);
  }
}

function handleMoreToggles(): void {
  document.querySelectorAll<HTMLButtonElement>(".more-toggle").forEach((button) => {
    const targetId = button.dataset.target;
    if (!targetId) {
      return;
    }
    const target = document.getElementById(targetId);
    if (!target) {
      return;
    }

    target.setAttribute("hidden", "");
    button.textContent = "More options";
    button.setAttribute("aria-expanded", "false");

    button.addEventListener("click", () => {
      const isHidden = target.hasAttribute("hidden");
      if (isHidden) {
        target.removeAttribute("hidden");
        button.textContent = "Hide options";
        button.setAttribute("aria-expanded", "true");
      } else {
        target.setAttribute("hidden", "");
        button.textContent = "More options";
        button.setAttribute("aria-expanded", "false");
      }
    });
  });
}

function listenForInvoiceGeneration(): void {
  if (!makeInvoiceForm) {
    return;
  }
  makeInvoiceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(makeInvoiceForm);
    const amount = Number(formData.get("amount"));
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast("Amount must be greater than zero");
      return;
    }

    const payload: Record<string, unknown> = { amount };
    const description = formData.get("description")?.toString().trim();
    const expiry = formData.get("expiry")?.toString().trim();
    if (description) {
      payload.description = description;
    }
    if (expiry) {
      const expirySeconds = Number(expiry);
      if (Number.isFinite(expirySeconds) && expirySeconds > 0) {
        payload.expiry = expirySeconds;
      }
    }

    try {
      showStatus("Generating invoice…");
      const result = await api<MakeInvoiceResponse>("/api/make-invoice", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (invoiceString && invoiceOutput) {
        invoiceString.textContent = result.invoice;
        invoiceOutput.removeAttribute("hidden");
      }
      if (invoiceQrCanvas) {
        await renderInvoiceToCanvas(invoiceQrCanvas, result.invoice);
      }
      showStatus("Invoice ready.");
      showToast("Invoice created");
      await updateBalance();
    } catch (error) {
      console.error(error);
      if (handleMissingPubkey(error)) {
        showToast("Server pubkey required");
        return;
      }
      showStatus("Failed to create invoice", true);
      showToast("Invoice failed");
    }
  });
}

function listenForInvoicePayment(): void {
  if (!payInvoiceForm || !payInvoiceOutput) {
    return;
  }
  payInvoiceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    payInvoiceOutput.value = "Routing lightning…";
    const formData = new FormData(payInvoiceForm);
    const invoice = formData.get("invoice")?.toString().trim();
    if (!invoice) {
      showToast("Invoice is required");
      payInvoiceOutput.value = "";
      return;
    }
    const amountValue = formData.get("amount")?.toString().trim();
    const payload: Record<string, unknown> = { invoice };
    if (amountValue) {
      const overrideAmount = Number(amountValue);
      if (Number.isFinite(overrideAmount) && overrideAmount > 0) {
        payload.amount = overrideAmount;
      }
    }
    try {
      const result = await api<PayInvoiceResponse>("/api/pay-invoice", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      payInvoiceOutput.value = `Paid ✓ Preimage ${result.preimage.slice(0, 18)}…`;
      payInvoiceOutput.style.color = "var(--signal-positive)";
      showToast("Invoice paid");
      await updateBalance();
    } catch (error) {
      console.error(error);
      if (handleMissingPubkey(error)) {
        payInvoiceOutput.value = "";
        payInvoiceOutput.style.color = "var(--signal-error)";
        showToast("Server pubkey required");
        return;
      }
      payInvoiceOutput.value = "Payment failed";
      payInvoiceOutput.style.color = "var(--signal-error)";
      showToast("Payment failed");
    }
  });
}

function setupInvoiceScanner(): void {
  if (!scanInvoiceButton || !invoiceScannerPanel || !payInvoiceForm) {
    return;
  }

  const invoiceField = payInvoiceForm.querySelector<HTMLTextAreaElement>("textarea[name=\"invoice\"]");
  if (!invoiceField) {
    return;
  }

  const disableScanner = (): void => {
    scanInvoiceButton.disabled = false;
    invoiceScannerPanel.setAttribute("hidden", "");
  };

  const handleCancel = async (): Promise<void> => {
    await cancelInvoiceScan();
    disableScanner();
    showStatus("Scanner closed");
    showToast("Scan cancelled");
  };

  if (scannerCancelButton) {
    scannerCancelButton.addEventListener("click", () => {
      void handleCancel();
    });
  }

  scanInvoiceButton.addEventListener("click", async () => {
    if (scanInvoiceButton.disabled) {
      return;
    }

    scanInvoiceButton.disabled = true;
    invoiceScannerPanel.removeAttribute("hidden");
    showStatus("Opening camera…");

    try {
      const decoded = await scanInvoiceOnce("invoice-scanner-view");
      invoiceField.value = decoded.trim();
      invoiceField.dispatchEvent(new Event("input", { bubbles: true }));
      showToast("Invoice captured");
      showStatus("Invoice scanned");
      invoiceField.focus();
      if (typeof payInvoiceForm.requestSubmit === "function") {
        payInvoiceForm.requestSubmit();
      } else {
        payInvoiceForm.submit();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scanner error";
      if (message !== "Scan cancelled" && !message.includes("Interrupt previous scan")) {
        showToast(message);
        showStatus("Scan failed", true);
      }
    } finally {
      await cancelInvoiceScan();
      disableScanner();
    }
  });
}

function listenForSendEcash(): void {
  if (!sendEcashForm || !sendEcashOutput) {
    return;
  }
  sendEcashForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(sendEcashForm);
    const amount = Number(formData.get("amount"));
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast("Amount must be greater than zero");
      return;
    }
    if (sendEcashTokenPanel) {
      sendEcashTokenPanel.setAttribute("hidden", "");
    }
    if (sendEcashTokenField) {
      sendEcashTokenField.value = "";
    }
    if (copyEcashTokenButton) {
      copyEcashTokenButton.disabled = true;
    }
    sendEcashOutput.value = "Minting token…";
    try {
      const result = await api<SendEcashResponse>("/api/send-ecash", {
        method: "POST",
        body: JSON.stringify({ amount }),
      });
      sendEcashOutput.value = `Token minted (${result.sentAmount.toLocaleString()} sats).`;
      sendEcashOutput.style.color = "var(--signal-positive)";
      if (sendEcashTokenPanel && sendEcashTokenField) {
        sendEcashTokenField.value = result.cashuToken;
        sendEcashTokenPanel.removeAttribute("hidden");
        sendEcashTokenField.focus();
        sendEcashTokenField.select();
      }
      if (copyEcashTokenButton) {
        copyEcashTokenButton.disabled = false;
      }
      showToast("Token ready");
      await updateBalance();
    } catch (error) {
      console.error(error);
      if (handleMissingPubkey(error)) {
        sendEcashOutput.value = "";
        showToast("Server pubkey required");
        return;
      }
      sendEcashOutput.value = "Failed to mint token";
      sendEcashOutput.style.color = "var(--signal-error)";
      showToast("Token mint failed");
    }
  });
}

function setupCopyInvoice(): void {
  if (!copyInvoiceButton || !invoiceString) {
    return;
  }

  copyInvoiceButton.addEventListener("click", async () => {
    const contents = invoiceString.textContent?.trim();
    if (!contents) {
      return;
    }
    try {
      await navigator.clipboard.writeText(contents);
      showToast("Invoice copied");
    } catch {
      showToast("Clipboard not available");
    }
  });
}

function setupCopyEcashToken(): void {
  if (!copyEcashTokenButton || !sendEcashTokenField) {
    return;
  }

  copyEcashTokenButton.disabled = true;

  copyEcashTokenButton.addEventListener("click", async () => {
    const token = sendEcashTokenField.value.trim();
    if (!token) {
      showToast("Token not ready");
      return;
    }
    try {
      await navigator.clipboard.writeText(token);
      showToast("Token copied");
    } catch {
      showToast("Clipboard not available");
    }
  });
}

function setupExitFlow(): void {
  if (!exitButton || !exitOverlay || !exitConfirmButton || !exitCancelButton) {
    return;
  }

  const originalWarning = exitWarning?.textContent ?? null;

  const hideExitOverlay = (): void => {
    exitOverlay.setAttribute("hidden", "");
    exitConfirmButton.disabled = false;
    exitConfirmButton.textContent = "Disconnect";
    if (exitWarning && originalWarning !== null) {
      exitWarning.textContent = originalWarning;
    }
  };

  exitButton.addEventListener("click", () => {
    exitOverlay.removeAttribute("hidden");
    showStatus("Ready to disconnect?");
  });

  exitCancelButton.addEventListener("click", () => {
    hideExitOverlay();
    showStatus("Server connection retained");
  });

  exitConfirmButton.addEventListener("click", async () => {
    if (exitConfirmButton.disabled) {
      return;
    }
    exitConfirmButton.disabled = true;
    exitConfirmButton.textContent = "Disconnecting…";
    try {
      await api<ClearPubkeyResponse>("/api/server-pubkey", { method: "DELETE" });
      showToast("Server disconnected");
      stopBalancePolling();
      if (pubkeyInput) {
        pubkeyInput.value = "";
      }
      hideExitOverlay();
      showPubkeyGate();
      setPubkeyError("Server pubkey removed. Insert a new pubkey to continue.");
      if (pubkeyHint) {
        pubkeyHint.textContent = "Connect with a new server key to continue.";
      }
      showStatus("Awaiting server pubkey…");
    } catch (error) {
      console.error(error);
      if (exitWarning) {
        exitWarning.textContent = "Disconnect attempt failed. Try again or refresh the page.";
      }
      showStatus("Failed to disconnect server", true);
      showToast("Disconnect failed");
      exitConfirmButton.disabled = false;
      exitConfirmButton.textContent = "Disconnect";
    }
  });
}

function init(): void {
  showStatus("Preparing wallet…");
  handleMoreToggles();
  listenForInvoiceGeneration();
  listenForInvoicePayment();
  setupInvoiceScanner();
  listenForSendEcash();
  setupCopyInvoice();
  setupCopyEcashToken();
  setupExitFlow();
  setupPubkeyFlow();
}

init();
