import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mi tienda · Inventario",
  description: "Inventario, entradas de mercancía y ventas. Caja principal con funcionamiento sin internet.",
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
