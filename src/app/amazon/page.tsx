import type { Metadata } from "next";
import { AmazonWorkbench } from "@/components/amazon-workbench";
import { getBuildVersion } from "@/lib/build-version";

export const metadata: Metadata = {
  title: "Amazon product matching — FinderApp",
  description:
    "Compare Regal Sales product data with Amazon UK listings using EAN, title, brand, variant, size and product images.",
};

export default function AmazonMatchingPage() {
  return <AmazonWorkbench buildVersion={getBuildVersion()} />;
}
