import Link from "next/link";

type ToolId = "regal" | "amazon";

const tools: ReadonlyArray<{ id: ToolId; href: string; label: string }> = [
  { id: "regal", href: "/", label: "Regal lookup" },
  { id: "amazon", href: "/amazon", label: "Amazon matching" },
];

export function ToolNavigation({
  active,
  buildVersion,
}: {
  active: ToolId;
  buildVersion: string;
}) {
  const isDevelopment = buildVersion === "development";
  const shortVersion = isDevelopment ? "LOCAL" : buildVersion.slice(0, 7);
  const versionDescription = isDevelopment
    ? "Local development build"
    : `Build from commit ${buildVersion}`;

  return (
    <div className="topbar-right tool-header">
      <nav className="tool-navigation" aria-label="FinderApp tools">
        {tools.map((tool) => (
          <Link
            key={tool.id}
            className="topbar-link tool-nav-link"
            href={tool.href}
            aria-current={active === tool.id ? "page" : undefined}
          >
            {tool.label}
          </Link>
        ))}
      </nav>
      <span className="build-version" aria-label={versionDescription} title={versionDescription}>
        <span className="build-version-dot" aria-hidden="true" />
        <span className="build-version-label">{isDevelopment ? "DEV" : "BUILD"}</span>
        <code>{shortVersion}</code>
      </span>
    </div>
  );
}
