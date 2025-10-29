import { Html5Qrcode } from "html5-qrcode";

let activeScanner: Html5Qrcode | null = null;
let activeCancel: ((reason?: Error) => Promise<void>) | null = null;

async function releaseScanner(scanner: Html5Qrcode): Promise<void> {
  try {
    await scanner.stop();
  } catch {
    // ignore stop errors
  }
  try {
    await scanner.clear();
  } catch {
    // ignore clear errors
  }
}

export async function cancelInvoiceScan(reason?: Error): Promise<void> {
  if (!activeCancel) {
    return;
  }
  const cancel = activeCancel;
  activeCancel = null;
  await cancel(reason ?? new Error("Scan cancelled"));
}

export async function scanInvoiceOnce(elementId: string): Promise<string> {
  await cancelInvoiceScan(new Error("Interrupt previous scan"));

  const scanner = new Html5Qrcode(elementId);
  activeScanner = scanner;

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const finish = async (): Promise<void> => {
      activeScanner = null;
      await releaseScanner(scanner);
    };

    const resolveOnce = async (value: string): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      activeCancel = null;
      await finish();
      resolve(value);
    };

    const rejectOnce = async (error: Error): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      activeCancel = null;
      await finish();
      reject(error);
    };

    activeCancel = async (reason?: Error): Promise<void> => {
      await rejectOnce(reason ?? new Error("Scan cancelled"));
    };

    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          void resolveOnce(decodedText);
        },
        () => {
          // ignore decode errors to keep scanning
        }
      )
      .catch((error) => {
        const failure =
          error instanceof Error ? error : new Error(typeof error === "string" ? error : "Failed to start scanner");
        void rejectOnce(failure);
      });
  });
}
