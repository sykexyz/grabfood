import { Link, useLocation } from 'wouter';
import { LayoutDashboard, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Sidebar() {
  const [location] = useLocation();

  const links = [
    { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  ];

  return (
    <div className="w-64 border-r border-border bg-card flex flex-col z-10 relative">
      <div className="h-16 flex items-center px-6 border-b border-border bg-black/50">
        <Terminal className="w-5 h-5 text-primary mr-3" />
        <span className="text-sm font-mono font-bold text-primary tracking-widest">GHOST_NET</span>
      </div>
      <nav className="flex-1 py-6 px-4 space-y-2 bg-black/20">
        {links.map((link) => {
          const active = location === link.href;
          const Icon = link.icon;
          return (
            <Link key={link.href} href={link.href} className={cn(
              "flex items-center px-4 py-3 text-sm font-mono transition-all rounded-none",
              active
                ? "bg-primary/10 text-primary border-l-2 border-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground border-l-2 border-transparent"
            )}>
              <Icon className="w-4 h-4 mr-3" />
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-border bg-black/50">
        <div className="flex items-center text-[11px] font-mono text-muted-foreground uppercase tracking-widest">
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse mr-3 shadow-[0_0_8px_hsl(var(--primary))]" />
          System Online
        </div>
      </div>
    </div>
  );
}
