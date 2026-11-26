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
  title: "FinderApp — Product lookup & Amazon matching",
  description:
    "Search Amazon UK from a product title or image URL, match product EANs against Regal Sales, and review listing matches.",
  applicationName: "FinderApp",
  openGraph: {
    title: "FinderApp — Product lookup & Amazon matching",
    description: "Test a product by title or image, enrich EAN data, and review Amazon UK listing matches.",
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
