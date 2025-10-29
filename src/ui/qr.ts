import QRCode from "qrcode";

export interface QROptions {
  scale?: number;
  color?: {
    dark?: string;
    light?: string;
  };
}

const defaultOptions: QROptions = {
  scale: 4,
  color: {
    dark: "#36c2ff",
    light: "#080016",
  },
};

export async function renderInvoiceToCanvas(
  canvas: HTMLCanvasElement,
  invoice: string,
  options: QROptions = {}
): Promise<void> {
  const merged = {
    ...defaultOptions,
    ...options,
    color: {
      ...defaultOptions.color,
      ...options.color,
    },
  };
  await QRCode.toCanvas(canvas, invoice, merged);
  canvas.style.width = "100%";
  canvas.style.maxWidth = "11rem";
  canvas.style.height = "auto";
}

export async function createInvoiceDataUrl(
  invoice: string,
  options: QROptions = {}
): Promise<string> {
  const merged = {
    ...defaultOptions,
    ...options,
    color: {
      ...defaultOptions.color,
      ...options.color,
    },
  };
  return QRCode.toDataURL(invoice, merged);
}
