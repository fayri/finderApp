import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FinderApp — Regal Sales EAN lookup",
  description:
    "Upload a CSV or Excel list of EANs, match products in the Regal Sales catalogue, and export image URLs, titles, pack sizes and product sizes.",
  applicationName: "FinderApp",
  openGraph: {
    title: "FinderApp — Regal Sales EAN lookup",
    description: "Turn product EANs into an enriched spreadsheet.",
    type: "website",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en-GB"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
