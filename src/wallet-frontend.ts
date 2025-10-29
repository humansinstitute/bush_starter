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

async function api<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json",
    },
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
  statusLine.style.color = isError ? "#ff3c7c" : "var(--text-muted)";
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

async function updateBalance(): Promise<void> {
  try {
    const data = await api<BalanceResponse>("/api/balance");
    if (balanceDisplay) {
      balanceDisplay.textContent = `${data.balance.toLocaleString()} sats`;
    }
    showStatus("Balance synced");
  } catch (error) {
    console.error(error);
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
      showStatus("Spawning invoice…");
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
      showStatus("Invoice ready. Share and stack!");
      showToast("Invoice created");
      await updateBalance();
    } catch (error) {
      console.error(error);
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
      payInvoiceOutput.style.color = "var(--crt-green)";
      showToast("Invoice paid");
      await updateBalance();
    } catch (error) {
      console.error(error);
      payInvoiceOutput.value = "Payment failed";
      payInvoiceOutput.style.color = "var(--danger)";
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
      sendEcashOutput.style.color = "var(--crt-green)";
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
      sendEcashOutput.value = "Failed to mint token";
      sendEcashOutput.style.color = "var(--danger)";
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

function init(): void {
  handleMoreToggles();
  listenForInvoiceGeneration();
  listenForInvoicePayment();
  setupInvoiceScanner();
  listenForSendEcash();
  setupCopyInvoice();
  setupCopyEcashToken();
  updateBalance();
  setInterval(updateBalance, 3000);
}

init();
