import Link from "next/link";

type ToolId = "regal" | "amazon";

const tools: ReadonlyArray<{ id: ToolId; href: string; label: string }> = [
  { id: "regal", href: "/", label: "Regal lookup" },
  { id: "amazon", href: "/amazon", label: "Amazon matching" },
];

export function ToolNavigation({ active }: { active: ToolId }) {
  return (
    <nav className="topbar-right tool-navigation" aria-label="FinderApp tools">
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
  );
}
