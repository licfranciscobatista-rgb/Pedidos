import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mi encargo · Pedidos Temu y SHEIN",
  description: "Organiza artículos, fotos y pagos de tus clientes. Importa y exporta tus pedidos de Temu y SHEIN en Excel.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es-DO">
      <body className="antialiased">{children}</body>
    </html>
  );
}
