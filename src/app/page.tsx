import { EanWorkbench } from "@/components/ean-workbench";
import { getBuildVersion } from "@/lib/build-version";

export default function Home() {
  return <EanWorkbench buildVersion={getBuildVersion()} />;
}
