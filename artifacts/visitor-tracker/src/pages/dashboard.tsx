import { useGetVisitStats, useListVisits } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sidebar } from '@/components/layout/sidebar';
import { VisitorMap } from '@/components/visitor-map';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { format } from 'date-fns';
import { Terminal, Crosshair, Globe, Users, ShieldAlert, Activity, Map } from 'lucide-react';

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetVisitStats({
    query: { refetchInterval: 10000 }
  });
  const { data: visits, isLoading: visitsLoading } = useListVisits({
    query: { refetchInterval: 10000 }
  });

  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const todayCount = stats?.visitsPerDay?.find((d: any) => d.date.startsWith(todayStr))?.count || 0;

  return (
    <div className="h-screen w-full bg-background text-foreground flex font-mono overflow-hidden selection:bg-primary/30">
      <Sidebar />
      <main className="flex-1 p-6 md:p-8 overflow-y-auto bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-black via-background to-background">
        <header className="mb-8 flex items-end justify-between border-b border-border pb-6">
          <div>
            <h1 className="text-2xl font-bold uppercase tracking-[0.2em] text-primary flex items-center">
              <Crosshair className="w-5 h-5 mr-3" />
              Telemetry Feed
            </h1>
            <p className="text-muted-foreground text-xs mt-2 uppercase tracking-widest">
              Live Visitor Acquisition &amp; Geospatial Tracking
            </p>
          </div>
          <div className="hidden md:flex items-center text-xs text-primary border border-primary/30 px-3 py-1.5 bg-primary/5 tracking-widest">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse mr-2 shadow-[0_0_5px_hsl(var(--primary))]" />
            ENCRYPTION: ACTIVE
          </div>
        </header>

        {statsLoading || visitsLoading ? (
          <div className="flex-1 flex items-center justify-center min-h-[400px]">
            <div className="animate-pulse text-primary flex flex-col items-center">
              <Terminal className="w-8 h-8 mb-4 opacity-80" />
              <p className="text-xs tracking-widest">ESTABLISHING SECURE UPLINK...</p>
            </div>
          </div>
        ) : (
          <div className="space-y-6 max-w-[1800px] mx-auto pb-12">
            {/* Stats Row */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 lg:gap-6">
              <StatCard title="TOTAL INTERCEPTS" value={stats?.totalVisits || 0} icon={Users} />
              <StatCard title="UNIQUE TARGETS" value={stats?.uniqueIps || 0} icon={ShieldAlert} />
              <StatCard title="LOCATION LOCKS" value={stats?.withLocation || 0} icon={Globe} />
              <StatCard title="ACTIVE (24H)" value={todayCount} icon={Activity} />
            </div>

            {/* Map & Chart Row */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 min-h-[450px]">
              <div className="xl:col-span-2 h-full flex flex-col min-h-[400px]">
                <Card className="flex-1 flex flex-col overflow-hidden bg-card/40 backdrop-blur rounded-none border-border">
                  <CardHeader className="py-3 px-4 border-b border-border bg-black/40">
                    <CardTitle className="text-xs tracking-[0.2em] text-primary flex items-center">
                      <Map className="w-4 h-4 mr-2" />
                      GLOBAL NODE DISTRIBUTION
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex-1 p-0 min-h-[350px]">
                    <VisitorMap visits={visits || []} />
                  </CardContent>
                </Card>
              </div>

              <div className="flex flex-col gap-6">
                {/* Top Countries */}
                <Card className="bg-card/40 backdrop-blur rounded-none border-border">
                  <CardHeader className="py-3 px-4 border-b border-border bg-black/40">
                    <CardTitle className="text-xs tracking-[0.2em] text-primary flex items-center">
                      <Globe className="w-4 h-4 mr-2" />
                      TOP ORIGIN NODES
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    {!stats?.topCountries?.length ? (
                      <p className="text-[10px] text-muted-foreground tracking-widest text-center py-4">NO DATA</p>
                    ) : (
                      <div className="space-y-3">
                        {stats.topCountries.map((c: any, i: number) => (
                          <div key={i} className="flex items-center justify-between">
                            <span className="text-xs text-foreground/80 truncate max-w-[140px]">{c.country || 'Unknown'}</span>
                            <div className="flex items-center gap-2">
                              <div className="h-1 bg-primary/30 rounded-none" style={{ width: `${Math.max(20, (c.count / (stats.topCountries[0]?.count || 1)) * 80)}px` }}>
                                <div className="h-full bg-primary rounded-none" style={{ width: '100%' }} />
                              </div>
                              <span className="text-xs text-primary font-mono">{c.count}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Daily chart */}
                <Card className="flex-1 bg-card/40 backdrop-blur rounded-none border-border">
                  <CardHeader className="py-3 px-4 border-b border-border bg-black/40">
                    <CardTitle className="text-xs tracking-[0.2em] text-primary flex items-center">
                      <Activity className="w-4 h-4 mr-2" />
                      SIGNAL ACTIVITY (14D)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart data={stats?.visitsPerDay || []} margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 12%)" />
                        <XAxis
                          dataKey="date"
                          tick={{ fill: 'hsl(0 0% 55%)', fontSize: 9 }}
                          tickFormatter={(d) => d.slice(5)}
                          interval={3}
                        />
                        <YAxis tick={{ fill: 'hsl(0 0% 55%)', fontSize: 9 }} />
                        <Tooltip
                          contentStyle={{ background: 'hsl(0 0% 5%)', border: '1px solid hsl(0 0% 12%)', borderRadius: 0, fontFamily: 'monospace', fontSize: 11 }}
                          labelStyle={{ color: 'hsl(150 100% 45%)' }}
                          itemStyle={{ color: 'hsl(0 0% 90%)' }}
                        />
                        <Bar dataKey="count" fill="hsl(150 100% 45%)" opacity={0.8} radius={0} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Recent visits table */}
            <Card className="bg-card/40 backdrop-blur rounded-none border-border">
              <CardHeader className="py-3 px-4 border-b border-border bg-black/40">
                <CardTitle className="text-xs tracking-[0.2em] text-primary flex items-center">
                  <Terminal className="w-4 h-4 mr-2" />
                  INTERCEPT LOG
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead className="text-[10px] text-primary/70 tracking-widest uppercase font-normal">TIME</TableHead>
                      <TableHead className="text-[10px] text-primary/70 tracking-widest uppercase font-normal">IP</TableHead>
                      <TableHead className="text-[10px] text-primary/70 tracking-widest uppercase font-normal">GEO</TableHead>
                      <TableHead className="text-[10px] text-primary/70 tracking-widest uppercase font-normal">COORDS</TableHead>
                      <TableHead className="text-[10px] text-primary/70 tracking-widest uppercase font-normal">DEVICE</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(visits || []).slice(0, 20).map((visit: any) => (
                      <TableRow key={visit.id} className="border-border hover:bg-primary/5 transition-colors">
                        <TableCell className="text-[11px] text-muted-foreground font-mono">
                          {format(new Date(visit.createdAt), 'MM-dd HH:mm:ss')}
                        </TableCell>
                        <TableCell className="text-[11px] font-mono text-primary">
                          {visit.ip || 'UNKNOWN'}
                        </TableCell>
                        <TableCell className="text-[11px] text-foreground/80">
                          {[visit.city, visit.country].filter(Boolean).join(', ') || <span className="text-muted-foreground/50">--</span>}
                        </TableCell>
                        <TableCell className="text-[11px] font-mono">
                          {visit.latitude != null && visit.longitude != null ? (
                            <a
                              href={`https://www.google.com/maps?q=${visit.latitude},${visit.longitude}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              {visit.latitude.toFixed(4)}, {visit.longitude.toFixed(4)}
                            </a>
                          ) : (
                            <span className="text-muted-foreground/50">--</span>
                          )}
                        </TableCell>
                        <TableCell className="text-[11px] text-muted-foreground leading-tight max-w-[300px]">
                          <div className="truncate text-foreground/80" title={visit.userAgent || ''}>
                            {visit.os || 'UNKNOWN_OS'} / {visit.browser || 'UNKNOWN_BROWSER'}
                          </div>
                          <div className="truncate text-[10px] opacity-60">
                            {visit.deviceType || 'UNKNOWN_DEVICE'}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!visits?.length && (
                      <TableRow>
                        <TableCell colSpan={5} className="h-32 text-center text-muted-foreground text-[10px] tracking-widest uppercase">
                          No intercept data available
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({ title, value, icon: Icon }: { title: string, value: number, icon: any }) {
  return (
    <Card className="bg-card/40 backdrop-blur border-border rounded-none relative overflow-hidden group">
      <div className="absolute top-0 left-0 w-full h-[1px] bg-primary/30 scale-x-0 group-hover:scale-x-100 transition-transform origin-left duration-500" />
      <CardContent className="p-5 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-bold text-primary/80 tracking-[0.2em] mb-2 uppercase">{title}</p>
          <p className="text-3xl font-light text-foreground tracking-tight">{value}</p>
        </div>
        <div className="w-10 h-10 border border-primary/20 bg-primary/5 flex items-center justify-center opacity-70 group-hover:opacity-100 transition-opacity">
          <Icon className="w-5 h-5 text-primary" />
        </div>
      </CardContent>
    </Card>
  );
}
