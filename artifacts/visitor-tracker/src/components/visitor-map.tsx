import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { format } from 'date-fns';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
});

const hackerIcon = L.divIcon({
  className: 'bg-transparent',
  html: `<div class="w-3 h-3 bg-[hsl(150,100%,45%)] rounded-full border border-black shadow-[0_0_12px_hsl(150,100%,45%)] animate-pulse"></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
  popupAnchor: [0, -8]
});

export function VisitorMap({ visits }: { visits: any[] }) {
  const visitsWithLoc = visits.filter(v => v.latitude != null && v.longitude != null);

  const defaultCenter: [number, number] = visitsWithLoc.length > 0
    ? [visitsWithLoc[0].latitude!, visitsWithLoc[0].longitude!]
    : [20, 0];

  return (
    <div className="w-full h-full bg-card relative z-0">
      <MapContainer
        center={defaultCenter}
        zoom={2}
        scrollWheelZoom={true}
        style={{ width: '100%', height: '100%', zIndex: 0 }}
      >
        <TileLayer
          attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        {visitsWithLoc.map(v => (
          <Marker
            key={v.id}
            position={[v.latitude!, v.longitude!]}
            icon={hackerIcon}
          >
            <Popup className="hacker-popup">
              <div className="p-3 text-xs font-mono">
                <div className="text-primary mb-2 border-b border-primary/30 pb-1 font-bold tracking-wider">
                  TARGET IDENTIFIED
                </div>
                <div className="space-y-1">
                  <div><span className="text-muted-foreground">IP:</span> <span className="text-foreground">{v.ip || 'UNKNOWN'}</span></div>
                  <div><span className="text-muted-foreground">LOC:</span> <span className="text-foreground">{v.latitude?.toFixed(4)}, {v.longitude?.toFixed(4)}</span></div>
                  {v.city && v.country && (
                    <div><span className="text-muted-foreground">GEO:</span> <span className="text-foreground">{v.city}, {v.country}</span></div>
                  )}
                  <div><span className="text-muted-foreground">TIME:</span> <span className="text-foreground">{format(new Date(v.createdAt), 'HH:mm:ss')}</span></div>
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
