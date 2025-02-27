import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';
import { FaSearch, FaPen, FaTrash, FaRuler, FaUndo, FaRedo, FaSave, FaLayerGroup, FaLocationArrow, FaEdit, FaChartArea } from 'react-icons/fa';
import { MdGpsFixed, MdGpsNotFixed } from 'react-icons/md';
import { Chart } from 'react-chartjs-2';
import { Chart as ChartJS } from 'chart.js/auto';
import { interpolateColor } from '../utils/colorUtils';


// Import leaflet-draw properly
if (typeof window !== 'undefined') {
  require('leaflet-draw');
}

// Extend the L namespace without redefining existing types
declare module 'leaflet' {
  namespace GeometryUtil {
    function geodesicArea(latLngs: L.LatLng[]): number;
    function distanceSegment(map: L.Map, point: L.LatLng, p1: L.LatLng, p2: L.LatLng): number;
  }

  interface DrawOptions {
    showArea?: boolean;
    shapeOptions?: {
      color?: string;
      fillColor?: string;
      fillOpacity?: number;
      weight?: number;
      opacity?: number;
    };
    touchIcon?: L.DivIcon;
    allowIntersection?: boolean;
  }

  interface Draw {
    Polygon: new (map: L.Map, options?: DrawOptions) => any;
  }

  interface DrawConstructor {
    Polygon: new (map: L.Map, options?: DrawOptions) => any;
  }

  interface Map {
    draw?: DrawConstructor;
  }

  interface ControlOptions {
    position?: ControlPosition;
  }

  interface Polygon {
    editing?: {
      enable(): void;
      disable(): void;
    };
  }
}

interface MapProps {
  onAreaUpdate?: (area: number) => void;
  apiKey?: string; // API key for your chosen AI service
}

interface SearchResult {
  display_name: string;
  lat: string;
  lon: string;
}

type MeasurementUnit = 'ha' | 'sqm' | 'acre' | 'sqft';

const UNIT_CONVERSIONS = {
  ha: {
    toSqMeters: 10000,
    fromSqMeters: 1/10000,
    decimals: 2
  },
  sqm: {
    toSqMeters: 1,
    fromSqMeters: 1,
    decimals: 0
  },
  acre: {
    toSqMeters: 4046.86,
    fromSqMeters: 1/4046.86,
    decimals: 2
  },
  sqft: {
    toSqMeters: 0.092903,
    fromSqMeters: 1/0.092903,
    decimals: 0
  }
};

// Update the TILE_LAYERS constant with appropriate zoom levels
const TILE_LAYERS = {
  satellite: {
    url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',  // Updated to Google Satellite
    attribution: '&copy; Google Maps',
    maxNativeZoom: 21,  // Maximum zoom level where tiles are available
    maxZoom: 21        // Maximum zoom level for the map
  },
  terrain: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenTopoMap contributors',
    maxNativeZoom: 17,
    maxZoom: 17
  },
  street: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxNativeZoom: 19,
    maxZoom: 19
  }
};

// Update the India center coordinates with proper typing
const INDIA_CENTER: L.LatLngTuple = [20.5937, 78.9629];  // Center of India
const INDIA_DEFAULT_ZOOM = 5;  // Shows most of India

// Add these type definitions at the top of your file
type UndoAction = {
  type: 'add' | 'delete';
  layer: L.Layer;
};

// Add these interfaces
interface DetectedBoundary {
  id: string;
  coordinates: L.LatLng[];
  area: number;
  createdAt: Date;
}

interface AIDetectionResponse {
  boundaries: {
    type: 'Polygon';
    coordinates: number[][][];
  }[];
}

interface BoundaryStyle {
  color: string;
  weight: number;
  opacity: number;
  fillOpacity: number;
}

const getBoundaryStyle = (boundaryType: string, confidence: number): BoundaryStyle => {
  const baseOpacity = Math.max(0.2, confidence);
  
  switch(boundaryType) {
    case 'road':
      return {
        color: '#ff4444',
        weight: 2,
        opacity: 0.8,
        fillOpacity: baseOpacity
      };
    case 'fence':
      return {
        color: '#44ff44',
        weight: 1,
        opacity: 0.8,
        fillOpacity: baseOpacity
      };
    case 'natural':
      return {
        color: '#4444ff',
        weight: 2,
        opacity: 0.8,
        fillOpacity: baseOpacity
      };
    default:
      return {
        color: '#3388ff',
        weight: 2,
        opacity: 0.8,
        fillOpacity: baseOpacity
      };
  }
};

interface Vertex {
  lat: number;
  lng: number;
}

interface FieldBoundary {
  vertices: Vertex[];
  area: number;
  perimeter: number;
}

const Map: React.FC<MapProps> = ({ onAreaUpdate, apiKey }) => {
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [areaSize, setAreaSize] = useState<string>('0');
  const [selectedUnit, setSelectedUnit] = useState<MeasurementUnit>('ha');
  const [mapLayer, setMapLayer] = useState<'satellite' | 'terrain' | 'street'>('satellite');
  const [undoStack, setUndoStack] = useState<L.LatLng[]>([]);
  const [redoStack, setRedoStack] = useState<L.LatLng[]>([]);
  const [gpsStatus, setGpsStatus] = useState<'inactive' | 'searching' | 'active'>('inactive');
  const [watchId, setWatchId] = useState<number | null>(null);
  const [currentPosition, setCurrentPosition] = useState<L.LatLng | null>(null);
  const positionMarkerRef = useRef<L.Marker | null>(null);
  const [locationError, setLocationError] = useState<string>('');
  const [drawHandler, setDrawHandler] = useState<any>(null);
  const [showElevationAnalysis, setShowElevationAnalysis] = useState(false);
  const [elevationData, setElevationData] = useState<{
    elevation: number;
    slope: number;
    min: number;
    max: number;
    avgSlope: number;
  } | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [selectedLayer, setSelectedLayer] = useState('streets');
  const [points, setPoints] = useState<L.LatLng[]>([]);
  const [distanceMarkers, setDistanceMarkers] = useState<L.Layer[]>([]);
  const [boundary, setBoundary] = useState<FieldBoundary>({
    vertices: [],
    area: 0,
    perimeter: 0
  });
  const [vertexMarkers, setVertexMarkers] = useState<L.Marker[]>([]);
  const [isEditingVertices, setIsEditingVertices] = useState(false);

  // Add layers configuration
  const mapLayers = {
    streets: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '© Esri'
    }),
    hybrid: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '© Esri'
    })
  };

  // Cycle through layers on button click
  const cycleMapLayer = () => {
    const layers = ['streets', 'satellite', 'hybrid'];
    const currentIndex = layers.indexOf(selectedLayer);
    const nextIndex = (currentIndex + 1) % layers.length;
    handleLayerChange(layers[nextIndex]);
  };

  // Handle layer change
  const handleLayerChange = (layer: string) => {
    if (!mapRef.current) return;
    
    Object.values(mapLayers).forEach(l => mapRef.current?.removeLayer(l));
    mapLayers[layer as keyof typeof mapLayers].addTo(mapRef.current);
    setSelectedLayer(layer);
  };

  // Set initial corner count to 1 when component mounts
  useEffect(() => {
    const cornerCount = document.querySelector('.corner-count');
    if (cornerCount) {
      cornerCount.textContent = '1';
    }
  }, []);

  const handleMapClick = useCallback((e: L.LeafletMouseEvent) => {
    if (!isDrawing) return;

    const newPoint = e.latlng;
    const newPoints = [...points, newPoint];
    setPoints(newPoints);
    setUndoStack(prev => [...prev, newPoint]);
    setRedoStack([]);

    const layers = drawnItemsRef.current?.getLayers() || [];
    if (layers.length === 0) {
      const polygon = L.polygon([newPoint], {
        color: '#3388ff',
        fillOpacity: 0.2,
        weight: 3,
        lineCap: 'round',
        lineJoin: 'round',
        className: 'rounded-polygon'
      }).addTo(drawnItemsRef.current!);
      
      const cornerCount = document.querySelector('.corner-count');
      if (cornerCount) {
        cornerCount.textContent = '1';
      }
    } else {
      const polygon = layers[0] as L.Polygon;
      polygon.setLatLngs(newPoints);
      polygon.setStyle({
        weight: 3,
        lineCap: 'round',
        lineJoin: 'round',
        className: 'rounded-polygon'
      });
      
      if (newPoints.length > 2) {
        updateAreaSize(L.GeometryUtil.geodesicArea(newPoints));
        const cornerCount = document.querySelector('.corner-count');
        if (cornerCount) {
          cornerCount.textContent = String(newPoints.length);
        }
      } else {
        const cornerCount = document.querySelector('.corner-count');
        if (cornerCount) {
          cornerCount.textContent = '2';
        }
      }
    }

    // Update markers with draggable functionality
    addDraggableVertexMarkers(newPoints);
    updateDistanceMarkers(newPoints);
  }, [isDrawing, points]);

  // Undo function
  const handleUndo = () => {
    if (points.length === 0) return;

    const newPoints = [...points];
    const removedPoint = newPoints.pop()!;
    setPoints(newPoints);
    setRedoStack(prev => [...prev, removedPoint]);

    const layers = drawnItemsRef.current?.getLayers() || [];
    if (layers.length > 0) {
      const polygon = layers[0] as L.Polygon;
      polygon.setLatLngs(newPoints);
      updateAreaSize(newPoints.length > 2 ? L.GeometryUtil.geodesicArea(newPoints) : 0);
    }

    // Update markers with draggable functionality
    addDraggableVertexMarkers(newPoints);
    updateDistanceMarkers(newPoints);
  };

  // Redo function
  const handleRedo = () => {
    if (redoStack.length === 0) return;

    const newRedoStack = [...redoStack];
    const point = newRedoStack.pop()!;
    setRedoStack(newRedoStack);
    setPoints(prev => [...prev, point]);

    const layers = drawnItemsRef.current?.getLayers() || [];
    if (layers.length > 0) {
      const polygon = layers[0] as L.Polygon;
      const newPoints = [...points, point];
      polygon.setLatLngs(newPoints);
      updateAreaSize(L.GeometryUtil.geodesicArea(newPoints));
      
      // Update markers with draggable functionality
      addDraggableVertexMarkers(newPoints);
    }
  };

  // Update your useEffect for map initialization
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      minZoom: 4,
      maxZoom: TILE_LAYERS[mapLayer].maxZoom,
      zoomControl: false,  // Disable default zoom control
      worldCopyJump: true, // Enable seamless world wrapping
      maxBoundsViscosity: 0, // Allow free movement
    }).setView(INDIA_CENTER, INDIA_DEFAULT_ZOOM);
    
    // Add custom zoom control to bottom right
    L.control.zoom({
      position: 'bottomright'
    }).addTo(map);

    // Remove bounds restrictions
    // const southWest: L.LatLngTuple = [6.7548, 68.1862];
    // const northEast: L.LatLngTuple = [35.6745, 97.3959];
    // const bounds = L.latLngBounds(southWest, northEast);
    // map.setMaxBounds(bounds);
    
    mapRef.current = map;

    // Initialize the base tile layer with proper zoom settings
    let currentBaseLayer = L.tileLayer(TILE_LAYERS[mapLayer].url, {
      attribution: TILE_LAYERS[mapLayer].attribution,
      maxNativeZoom: TILE_LAYERS[mapLayer].maxNativeZoom,
      maxZoom: TILE_LAYERS[mapLayer].maxZoom,
      noWrap: false, // Allow the map to wrap around the world
    }).addTo(map);

    // Add labels layer for satellite view with proper zoom settings
    let labelsLayer: L.TileLayer | null = null;
    if (mapLayer === 'satellite') {
      labelsLayer = L.tileLayer('https://{s}.google.com/vt/lyrs=h&x={x}&y={y}&z={z}', {
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
        pane: 'overlayPane',
        opacity: 0.9,
        maxNativeZoom: 19,
        maxZoom: 19,
        noWrap: false, // Allow the labels to wrap around the world
      }).addTo(map);
    }

    // Create the FeatureGroup for drawn items
    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    drawnItemsRef.current = drawnItems;

    // Add draw created event listener
    map.on((L as any).Draw.Event.CREATED, handleDrawCreated);

    // Remove the drag event listener that was restricting movement
    // map.off('drag');

    // Cleanup function
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    
    const map = mapRef.current;
    
    // Update map max zoom based on selected layer
    map.setMaxZoom(TILE_LAYERS[mapLayer].maxZoom);
    
    // Remove existing layers
    map.eachLayer((layer: any) => {
      if (layer instanceof L.TileLayer) {
        map.removeLayer(layer);
      }
    });
    
    // Add new base layer with proper zoom settings
    L.tileLayer(TILE_LAYERS[mapLayer].url, {
      attribution: TILE_LAYERS[mapLayer].attribution,
      maxNativeZoom: TILE_LAYERS[mapLayer].maxNativeZoom,
      maxZoom: TILE_LAYERS[mapLayer].maxZoom
    }).addTo(map);

    // Add labels layer for satellite view with proper zoom settings
    if (mapLayer === 'satellite') {
      L.tileLayer('https://{s}.google.com/vt/lyrs=h&x={x}&y={y}&z={z}', {
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
        pane: 'overlayPane',
        opacity: 0.9,
        maxNativeZoom: 19,
        maxZoom: 19
      }).addTo(map);
    }
  }, [mapLayer]);

  const updateAreaSize = (area: number) => {
    // Convert from square meters to selected unit
    const conversion = UNIT_CONVERSIONS[selectedUnit];
    const convertedArea = area * conversion.fromSqMeters;
    
    // Format with appropriate decimal places
    setAreaSize(convertedArea.toFixed(conversion.decimals));
    
    // Call the onAreaUpdate prop if it exists
    if (onAreaUpdate) {
      onAreaUpdate(convertedArea);
    }
  };

  const startDrawing = () => {
    if (!mapRef.current) return;
    
    if (isDrawing && drawHandler) {
      drawHandler.disable();
      setDrawHandler(null);
      setIsDrawing(false);
      return;
    }

    const polygonDrawHandler = new (L as any).Draw.Polygon(mapRef.current, {
      showArea: true,
      shapeOptions: {
        color: '#3388ff',
        fillColor: '#3388ff',
        fillOpacity: 0.2,
        weight: 3,
        opacity: 0.8,
        smoothFactor: 5,
        lineCap: 'round',
        lineJoin: 'round',
        className: 'rounded-polygon'
      },
      touchIcon: new L.DivIcon({
        className: 'leaflet-div-icon',
        iconSize: new L.Point(20, 20),
        iconAnchor: new L.Point(10, 10)
      }),
      allowIntersection: false
    });
    
    polygonDrawHandler.enable();
    setDrawHandler(polygonDrawHandler);
    setIsDrawing(true);
  };

  useEffect(() => {
    const searchTimeout = setTimeout(async () => {
      if (searchQuery.trim().length < 2) {
        setSearchResults([]);
        return;
      }

      setIsSearching(true);
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?` +
          `format=json&` +
          `q=${encodeURIComponent(searchQuery)}+Rajasthan+India&` +
          `limit=5&` +
          `dedupe=1`
        );
        
        const data = await response.json();
        
        const processedResults = data.map((item: any) => ({
          display_name: item.display_name,
          lat: item.lat,
          lon: item.lon
        }));

        setSearchResults(processedResults);
      } catch (error) {
        console.error('Search failed:', error);
      } finally {
        setIsSearching(false);
      }
    }, 30);

    return () => clearTimeout(searchTimeout);
  }, [searchQuery]);

  const handleResultClick = (result: SearchResult) => {
    if (!mapRef.current) return;

    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);

    mapRef.current.setView([lat, lon], 14, {
      animate: true,
      duration: 1.5
    });

    setSearchResults([]);
    setSearchQuery('');
  };

  // GPS tracking function
  const toggleGPS = () => {
    if (gpsStatus === 'inactive') {
      setGpsStatus('searching');
      
      if ('geolocation' in navigator) {
        // Get initial position
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const latLng = L.latLng(position.coords.latitude, position.coords.longitude);
            setCurrentPosition(latLng);
            
            if (mapRef.current) {
              mapRef.current.setView(latLng, 18);
              
              // Create or update position marker
              if (!positionMarkerRef.current) {
                positionMarkerRef.current = L.marker(latLng, {
                  icon: L.divIcon({
                    className: 'gps-marker',
                    html: '<div class="w-4 h-4 bg-blue-500 rounded-full border-2 border-white shadow-lg"></div>',
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                  })
                }).addTo(mapRef.current);
              } else {
                positionMarkerRef.current.setLatLng(latLng);
              }
            }

            // Start watching position
            const id = navigator.geolocation.watchPosition(
              (pos) => {
                const newLatLng = L.latLng(pos.coords.latitude, pos.coords.longitude);
                setCurrentPosition(newLatLng);
                
                if (positionMarkerRef.current) {
                  positionMarkerRef.current.setLatLng(newLatLng);
                }
                
                if (isDrawing && drawnItemsRef.current) {
                  const layers = drawnItemsRef.current.getLayers();
                  if (layers.length > 0) {
                    const polygon = layers[0] as L.Polygon;
                    const latlngs = polygon.getLatLngs()[0] as L.LatLng[];
                    latlngs.push(newLatLng);
                    polygon.setLatLngs(latlngs);
                    updateAreaSize(L.GeometryUtil.geodesicArea(latlngs));
                  } else {
                    L.polygon([newLatLng], {
                      color: '#3388ff',
                      fillOpacity: 0.2,
                    }).addTo(drawnItemsRef.current);
                  }
                }
              },
              (error) => {
                console.error('GPS Error:', error);
                setGpsStatus('inactive');
                alert('Unable to get GPS location. Please check your device settings.');
              },
              {
                enableHighAccuracy: true,
                timeout: 5000,
                maximumAge: 0
              }
            );
            
            setWatchId(id);
            setGpsStatus('active');
          },
          (error) => {
            console.error('GPS Error:', error);
            setGpsStatus('inactive');
            alert('Unable to get GPS location. Please check your device settings.');
          },
          {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 0
          }
        );
      } else {
        alert('GPS is not supported on this device or browser.');
        setGpsStatus('inactive');
      }
    } else {
      // Stop GPS tracking
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        setWatchId(null);
      }
      
      // Remove position marker
      if (positionMarkerRef.current && mapRef.current) {
        mapRef.current.removeLayer(positionMarkerRef.current);
        positionMarkerRef.current = null;
      }
      
      setGpsStatus('inactive');
      setCurrentPosition(null);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }
      if (positionMarkerRef.current && mapRef.current) {
        mapRef.current.removeLayer(positionMarkerRef.current);
      }
    };
  }, [watchId]);

  // Add GPS marker styles
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      .gps-marker {
        background: none;
        border: none;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // Update the handleDrawCreated function
  const handleDrawCreated = (e: any) => {
    const layer = e.layer;
    if (drawnItemsRef.current) {
      layer.setStyle({
        smoothFactor: 5,
        lineCap: 'round',
        lineJoin: 'round',
        className: 'rounded-polygon'
      });
      
      drawnItemsRef.current.addLayer(layer);
      setUndoStack(prev => [...prev, layer.getLatLngs()[0] as L.LatLng]);
      setRedoStack([]);
      updateAreaSize(L.GeometryUtil.geodesicArea(layer.getLatLngs()[0] as L.LatLng[]));
    }
  };

  // Add some CSS to style the zoom controls
  useEffect(() => {
    // Add custom CSS for zoom controls
    const style = document.createElement('style');
    style.textContent = `
      .leaflet-control-zoom {
        margin-bottom: 80px !important;  /* Add space above bottom tools */
        margin-right: 20px !important;   /* Add space from right edge */
        border: none !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3) !important;
      }
      .leaflet-control-zoom a {
        width: 36px !important;
        height: 36px !important;
        line-height: 36px !important;
        border-radius: 8px !important;
        background-color: white !important;
        color: #666 !important;
        border: 1px solid #ddd !important;
      }
      .leaflet-control-zoom a:first-child {
        margin-bottom: 4px !important;
      }
      .leaflet-control-zoom a:hover {
        background-color: #f4f4f4 !important;
        color: #333 !important;
      }
    `;
    document.head.appendChild(style);

    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // Fixed color interpolation function
  const interpolateColor = (color1: string, color2: string, ratio: number): string => {
    // Ensure colors are valid hex strings
    if (!color1 || !color2 || typeof color1 !== 'string' || typeof color2 !== 'string') {
      return '#ff0000'; // Default to red if invalid colors
    }

    try {
      // Remove # if present and ensure 6 characters
      const c1 = color1.replace('#', '').padEnd(6, '0');
      const c2 = color2.replace('#', '').padEnd(6, '0');

      const r1 = parseInt(c1.slice(0, 2), 16);
      const g1 = parseInt(c1.slice(2, 4), 16);
      const b1 = parseInt(c1.slice(4, 6), 16);
      
      const r2 = parseInt(c2.slice(0, 2), 16);
      const g2 = parseInt(c2.slice(2, 4), 16);
      const b2 = parseInt(c2.slice(4, 6), 16);
      
      const r = Math.round(r1 + (r2 - r1) * ratio);
      const g = Math.round(g1 + (g2 - g1) * ratio);
      const b = Math.round(b1 + (b2 - b1) * ratio);
      
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    } catch (error) {
      console.error('Color interpolation error:', error);
      return '#ff0000'; // Default to red if interpolation fails
    }
  };

  // Fixed elevation color function
  const getElevationColor = (elevation: number, min: number, max: number): string => {
    const ratio = (elevation - min) / (max - min);
    // Color gradient from low (blue) to high (red)
    const colors = [
      '#2b83ba', // blue - lowest
      '#abdda4', // blue-green
      '#ffffbf', // yellow
      '#fdae61', // orange
      '#d7191c'  // red - highest
    ];
    
    // Ensure ratio is between 0 and 1
    const safeRatio = Math.max(0, Math.min(1, ratio));
    const index = Math.min(Math.floor(safeRatio * (colors.length - 1)), colors.length - 2);
    const remainder = (safeRatio * (colors.length - 1)) - index;
    
    // Ensure valid colors are selected
    const color1 = colors[index] || colors[0];
    const color2 = colors[index + 1] || colors[colors.length - 1];
    
    return interpolateColor(color1, color2, remainder);
  };

  // Add function to get real elevation data from Google Maps API
  const getElevationData = async (points: L.LatLng[]) => {
    // Split points into chunks of 500 (API limit)
    const chunkSize = 500;
    const chunks = [];
    for (let i = 0; i < points.length; i += chunkSize) {
      chunks.push(points.slice(i, i + chunkSize));
    }

    // Get elevation for each chunk
    const allResults = [];
    for (const chunk of chunks) {
      const response = await fetch('/api/elevation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          points: chunk.map(p => ({ lat: p.lat, lng: p.lng })),
          apiKey: apiKey
        })
      });

      const data = await response.json();
      if (data.results) {
        allResults.push(...data.results);
      }
    }

    return allResults.map((result: any) => ({
      elevation: result.elevation,
      location: L.latLng(result.location.lat, result.location.lng)
    }));
  };

  // Update analyzeElevation function with better error handling
  const analyzeElevation = async () => {
    if (!drawnItemsRef.current) return;
    
    try {
      setIsAnalyzing(true);
      const layers = drawnItemsRef.current.getLayers();
      if (layers.length === 0) {
        alert('Please draw a field first');
        return;
      }

      if (!apiKey) {
        throw new Error('Google Maps API key is missing');
      }

      const polygon = layers[layers.length - 1] as L.Polygon;
      const bounds = polygon.getBounds();
      const points = polygon.getLatLngs()[0] as L.LatLng[];

      // Create grid points with reduced density
      const gridPoints = createAnalysisGrid(bounds, points as L.LatLng[], 5);

      // Split points into smaller chunks
      const chunkSize = 100; // Reduced chunk size
      const allElevationData = [];
      
      for (let i = 0; i < gridPoints.length; i += chunkSize) {
        const chunk = gridPoints.slice(i, i + chunkSize);
        
        const response = await fetch('/api/elevation', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            points: chunk.map(p => ({ lat: p.lat, lng: p.lng })),
            apiKey
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message || 'Failed to fetch elevation data');
        }

        const data = await response.json();
        
        if (!data.results || !Array.isArray(data.results)) {
          throw new Error('Invalid elevation data format');
        }

        const chunkElevationData = data.results.map((result: any, index: number) => ({
          elevation: result.elevation,
          location: chunk[index]
        }));

        allElevationData.push(...chunkElevationData);

        // Add a small delay between chunks to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (allElevationData.length === 0) {
        throw new Error('No elevation data received');
      }

      // Calculate statistics
      const elevations = allElevationData.map(point => point.elevation);
      const min = Math.min(...elevations);
      const max = Math.max(...elevations);

      // Remove existing elevation overlay
      if (drawnItemsRef.current) {
        drawnItemsRef.current.eachLayer((layer) => {
          if ((layer as any).isElevationOverlay) {
            drawnItemsRef.current?.removeLayer(layer);
          }
        });
      }

      // Create elevation visualization
      allElevationData.forEach((data, index) => {
        if (index < gridPoints.length - 1) {
          const ratio = (data.elevation - min) / (max - min);
          const color = interpolateColor('#2b83ba', '#d7191c', ratio);
          
          const cell = L.polygon([
            data.location,
            gridPoints[index + 1],
            gridPoints[Math.min(index + 11, gridPoints.length - 1)],
            gridPoints[Math.min(index + 10, gridPoints.length - 1)]
          ], {
            color: color,
            fillColor: color,
            fillOpacity: 0.6,
            weight: 0,
            className: 'elevation-cell'
          });
          
          (cell as any).isElevationOverlay = true;
          cell.bindPopup(`
            <div class="text-sm">
              <strong>Elevation:</strong> ${data.elevation.toFixed(1)}m<br>
              <strong>Location:</strong> ${data.location.lat.toFixed(6)}, ${data.location.lng.toFixed(6)}
            </div>
          `);
          drawnItemsRef.current?.addLayer(cell);
        }
      });

      // Add enhanced legend
      const legend = L.Control.extend({
        options: {
          position: 'bottomright'
        },
        onAdd: function() {
          const div = L.DomUtil.create('div', 'elevation-legend');
          div.innerHTML = `
            <div class="bg-white p-3 rounded-lg shadow-lg">
              <div class="text-sm font-medium mb-2">Elevation Analysis</div>
              <div class="flex items-center gap-2 mb-2">
                <div class="w-24 h-4 bg-gradient-to-r from-[#2b83ba] to-[#d7191c]"></div>
                <div class="flex justify-between w-full text-xs">
                  <span>${min.toFixed(1)}m</span>
                  <span>${max.toFixed(1)}m</span>
                </div>
              </div>
              <div class="text-xs space-y-1">
                <div>Elevation Range: ${(max - min).toFixed(1)}m</div>
                <div>Average: ${(elevations.reduce((a, b) => a + b, 0) / elevations.length).toFixed(1)}m</div>
                <div>Slope: ${((max - min) / (bounds.getNorth() - bounds.getSouth()) * 100).toFixed(1)}%</div>
              </div>
            </div>
          `;
          return div;
        }
      });
      new legend().addTo(mapRef.current!);

    } catch (error) {
      console.error('Elevation analysis failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      alert(`Failed to analyze elevation: ${errorMessage}. Please check your API key and try again.`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Add helper function for grid creation
  const createAnalysisGrid = (bounds: L.LatLngBounds, points: L.LatLng[], density: number) => {
    const gridPoints: L.LatLng[] = [];
    const latStep = (bounds.getNorth() - bounds.getSouth()) / density;
    const lngStep = (bounds.getEast() - bounds.getWest()) / density;
    
    for (let lat = bounds.getSouth(); lat <= bounds.getNorth(); lat += latStep) {
      for (let lng = bounds.getWest(); lng <= bounds.getEast(); lng += lngStep) {
        const point = L.latLng(lat, lng);
        if (isPointInPolygon(point, points)) {
          gridPoints.push(point);
        }
      }
    }
    
    return gridPoints;
  };

  // Add helper function for point in polygon check
  const isPointInPolygon = (point: L.LatLng, polygon: L.LatLng[]): boolean => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].lat;
      const yi = polygon[i].lng;
      const xj = polygon[j].lat;
      const yj = polygon[j].lng;

      const intersect = ((yi > point.lng) !== (yj > point.lng)) &&
        (point.lat < (xj - xi) * (point.lng - yi) / (yj - yi) + xi);
      
      if (intersect) inside = !inside;
    }
    return inside;
  };

  useEffect(() => {
    if (!mapRef.current || !drawnItemsRef.current) return;

    mapRef.current.on('click', handleMapClick);

    return () => {
      mapRef.current?.off('click', handleMapClick);
    };
  }, [mapRef.current, isDrawing, handleMapClick]);

  // Toggle drawing mode
  const toggleDrawing = () => {
    if (isEditing) {
      const layers = drawnItemsRef.current?.getLayers() || [];
      if (layers.length > 0) {
        const polygon = layers[0] as L.Polygon;
        if (polygon.editing) {
          polygon.editing.disable();
        }
      }
      setIsEditing(false);
    }

    const newIsDrawing = !isDrawing;
    setIsDrawing(newIsDrawing);

    // When stopping drawing, keep the vertex markers draggable
    if (!newIsDrawing && points.length > 0) {
      addDraggableVertexMarkers(points);
    }

    // Reset when starting new drawing
    if (newIsDrawing) {
      const cornerCount = document.querySelector('.corner-count');
      if (cornerCount) {
        cornerCount.textContent = '1';
      }
      setPoints([]);
      distanceMarkers.forEach(marker => {
        mapRef.current?.removeLayer(marker);
      });
      setDistanceMarkers([]);
      
      // Clear existing vertex markers
      vertexMarkers.forEach(marker => {
        mapRef.current?.removeLayer(marker);
      });
      setVertexMarkers([]);
    }
  };

  const clearAllDistanceMarkers = () => {
    if (!mapRef.current) return;
    
    // Remove all markers with distance-marker class
    mapRef.current.eachLayer((layer) => {
      if (layer instanceof L.Marker) {
        const element = layer.getElement();
        if (element && element.classList.contains('distance-marker')) {
          mapRef.current?.removeLayer(layer);
        }
      }
    });
    
    // Also clear from our state
    distanceMarkers.forEach(marker => {
      if (mapRef.current) {
        mapRef.current.removeLayer(marker);
      }
    });
    setDistanceMarkers([]);
  };

  const updateDistanceMarkers = (points: L.LatLng[]) => {
    clearAllDistanceMarkers();
    if (points.length < 2) return;

    const newMarkers: L.Layer[] = [];

    for (let i = 0; i < points.length; i++) {
      const p1 = points[i];
      const p2 = points[(i + 1) % points.length];

      // Calculate midpoint
      const midPoint = L.latLng((p1.lat + p2.lat) / 2, (p1.lng + p2.lng) / 2);

      // Calculate angle between points (for edge direction)
      const angle = Math.atan2(p2.lng - p1.lng, p2.lat - p1.lat);
      
      // Adjust label positioning perpendicular to the edge
      const offsetDistance = 0.0002; // Adjust this for spacing
      const labelPoint = L.latLng(
        midPoint.lat + offsetDistance * Math.sin(angle),
        midPoint.lng - offsetDistance * Math.cos(angle)
      );

      // Calculate the distance between points
      const distance = p1.distanceTo(p2);
      const formattedDistance = distance >= 1000 
        ? `${(distance / 1000).toFixed(2)} km`
        : `${Math.round(distance)} m`;

      // Create the rotated label
      const marker = L.marker(labelPoint, {
        icon: L.divIcon({
          className: 'distance-marker',
          html: `<div class="distance-label" style="transform: rotate(${90 - angle * (180 / Math.PI)}deg)">
                  ${formattedDistance}
                </div>`,
          iconSize: [80, 20],
          iconAnchor: [40, 10]
        }),
        interactive: false
      });

      if (mapRef.current) {
        marker.addTo(mapRef.current);
        newMarkers.push(marker);
      }
    }

    setDistanceMarkers(newMarkers);
  };

  const handleDelete = () => {
    if (drawnItemsRef.current) {
      drawnItemsRef.current.clearLayers();
      
      // Clear vertex markers
      vertexMarkers.forEach(marker => {
        mapRef.current?.removeLayer(marker);
      });
      setVertexMarkers([]);
      
      // Clear all other markers and states
      if (mapRef.current) {
        mapRef.current.eachLayer((layer) => {
          if (layer instanceof L.Marker) {
            mapRef.current?.removeLayer(layer);
          }
        });
      }
      
      setPoints([]);
      setUndoStack([]);
      setRedoStack([]);
      setDistanceMarkers([]);
      updateAreaSize(0);

      const cornerCount = document.querySelector('.corner-count');
      if (cornerCount) {
        cornerCount.textContent = '0';
      }
    }
  };

  // Add CSS styles for increased radius
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      .rounded-polygon {
        stroke-linejoin: round;
        stroke-linecap: round;
        border-radius: 15px;  /* Increased border radius */
      }
      .rounded-polygon path {
        stroke-linejoin: round;
        stroke-linecap: round;
      }
    `;
    document.head.appendChild(style);
    
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // Vertex को drag करने के लिए handler
  const handleVertexDrag = (index: number, newPosition: Vertex) => {
    setBoundary(prev => {
      const newVertices = [...prev.vertices];
      newVertices[index] = newPosition;
      return {
        ...prev,
        vertices: newVertices
      };
    });
  };

  // Edge के middle point को drag करने के लिए handler
  const handleEdgeDrag = (index: number, newPosition: Vertex) => {
    setBoundary(prev => {
      const newVertices = [...prev.vertices];
      // नया vertex add करें edges के बीच में
      newVertices.splice(index + 1, 0, newPosition);
      return {
        ...prev,
        vertices: newVertices
      };
    });
  };

  // Update the vertex marker creation to make them draggable
  const addDraggableVertexMarkers = (points: L.LatLng[]) => {
    // First, clear ALL existing markers from the map
    if (mapRef.current) {
      mapRef.current.eachLayer((layer) => {
        if (layer instanceof L.Marker) {
          mapRef.current?.removeLayer(layer);
        }
      });
    }
    
    // Also clear from our state
    vertexMarkers.forEach(marker => {
      if (mapRef.current) {
        mapRef.current.removeLayer(marker);
      }
    });
    setVertexMarkers([]);

    if (points.length === 0) return;

    // Create new draggable vertex markers
    const newMarkers = points.map((point, index) => {
      const marker = L.marker(point, {
        icon: L.divIcon({
          className: 'vertex-marker',
          html: '<div class="vertex-marker-inner"></div>',
          iconSize: [12, 12],
          iconAnchor: [6, 6]
        }),
        draggable: true
      });

      if (mapRef.current) {
        marker.addTo(mapRef.current);

        marker.on('dragstart', () => {
          const element = marker.getElement();
          if (element) {
            element.style.backgroundColor = '#ff3333';
          }
        });

        marker.on('drag', (e) => {
          const newLatLng = e.target.getLatLng();
          const layers = drawnItemsRef.current?.getLayers() || [];
          if (layers.length > 0) {
            const polygon = layers[0] as L.Polygon;
            const currentPoints = [...polygon.getLatLngs()[0] as L.LatLng[]];
            currentPoints[index] = newLatLng;
            
            polygon.setLatLngs(currentPoints);
            updateAreaSize(L.GeometryUtil.geodesicArea(currentPoints));
            setPoints(currentPoints);
            updateDistanceMarkers(currentPoints);
          }
        });

        marker.on('dragend', () => {
          const element = marker.getElement();
          if (element) {
            element.style.backgroundColor = '#ffffff';
          }
        });
      }

      return marker;
    });

    setVertexMarkers(newMarkers);
  };

  // Helper function to add event listeners to markers
  const addMarkerEventListeners = (marker: L.Marker, index: number, points: L.LatLng[]) => {
    marker.on('dragstart', () => {
      const element = marker.getElement();
      if (element) {
        element.style.backgroundColor = '#ff3333';
      }
    });

    marker.on('drag', (e) => {
      const newLatLng = e.target.getLatLng();
      const layers = drawnItemsRef.current?.getLayers() || [];
      if (layers.length > 0) {
        const polygon = layers[0] as L.Polygon;
        const currentPoints = [...polygon.getLatLngs()[0] as L.LatLng[]];
        currentPoints[index] = newLatLng;
        
        polygon.setLatLngs(currentPoints);
        updateAreaSize(L.GeometryUtil.geodesicArea(currentPoints));
        setPoints(currentPoints);
        updateDistanceMarkers(currentPoints);
      }
    });

    marker.on('dragend', () => {
      const element = marker.getElement();
      if (element) {
        element.style.backgroundColor = '#ffffff';
      }
    });
  };

  // Update CSS for better visibility during drag
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      .vertex-marker {
        background: none !important;
        border: none !important;
        z-index: 1000 !important;
      }
      .vertex-marker-inner {
        width: 12px;
        height: 12px;
        background: white;
        border: 2px solid #3388ff;
        border-radius: 50%;
        cursor: move;
        transition: all 0.2s ease;
      }
      .vertex-marker-inner:hover {
        transform: scale(1.2);
        background: #e6e6e6;
      }
      .vertex-marker.dragging .vertex-marker-inner {
        background: #ff3333;
        transform: scale(1.2);
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // Add new function to enable vertex editing
  const enableVertexEditing = () => {
    if (!drawnItemsRef.current) return;
    
    setIsEditingVertices(!isEditingVertices);
    setIsDrawing(false); // Disable drawing mode when editing

    const layers = drawnItemsRef.current.getLayers();
    if (layers.length === 0) {
      alert('Please draw a field first');
      return;
    }

    const polygon = layers[0] as L.Polygon;
    const vertices = polygon.getLatLngs()[0] as L.LatLng[];

    if (isEditingVertices) {
      // Disable editing
      vertexMarkers.forEach(marker => {
        mapRef.current?.removeLayer(marker);
      });
      setVertexMarkers([]);
    } else {
      // Enable editing
      addDraggableVertexMarkers(vertices);
    }
  };

  // Add CSS for vertex markers
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      .vertex-marker {
        background: none !important;
        border: none !important;
      }
      .vertex-marker-inner {
        width: 12px;
        height: 12px;
        background: white;
        border: 2px solid #3388ff;
        border-radius: 50%;
        cursor: move;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // Add CSS for distance markers
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      .distance-marker {
        background: none;
        border: none;
        pointer-events: none;
      }
      .distance-label {
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
        display: inline-block;
        transform-origin: center;
        text-align: center;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // Add distance calculation function
  const distanceToSegment = (point: L.LatLng, start: L.LatLng, end: L.LatLng) => {
    const x = point.lat;
    const y = point.lng;
    const x1 = start.lat;
    const y1 = start.lng;
    const x2 = end.lat;
    const y2 = end.lng;

    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const len_sq = C * C + D * D;
    let param = -1;

    if (len_sq !== 0) {
      param = dot / len_sq;
    }

    let xx, yy;

    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }

    const dx = x - xx;
    const dy = y - yy;

    return Math.sqrt(dx * dx + dy * dy) * 111000; // Convert to meters (roughly)
  };

  // Helper function to get closest point on a line segment
  const getClosestPointOnSegment = (p: L.LatLng, start: L.LatLng, end: L.LatLng): L.LatLng => {
    const x = p.lat;
    const y = p.lng;
    const x1 = start.lat;
    const y1 = start.lng;
    const x2 = end.lat;
    const y2 = end.lng;

    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const len_sq = C * C + D * D;
    let param = -1;

    if (len_sq !== 0) {
      param = dot / len_sq;
    }

    let xx, yy;

    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }

    return L.latLng(xx, yy);
  };

  // Update handleEdgeClick to properly handle polygon clicks
  const handleEdgeClick = (e: L.LeafletMouseEvent) => {
    if (!drawnItemsRef.current || isDrawing) return; // Don't handle edge clicks while drawing

    const layers = drawnItemsRef.current.getLayers();
    if (layers.length === 0) return;

    const polygon = layers[0] as L.Polygon;
    const vertices = polygon.getLatLngs()[0] as L.LatLng[];
    const clickPoint = e.latlng;

    // Find the closest edge
    let minDistance = Infinity;
    let insertIndex = -1;
    let closestPoint: L.LatLng | null = null;

    for (let i = 0; i < vertices.length; i++) {
      const start = vertices[i];
      const end = vertices[(i + 1) % vertices.length];
      
      const point = getClosestPointOnSegment(clickPoint, start, end);
      const distance = clickPoint.distanceTo(point);

      if (distance < minDistance) {
        minDistance = distance;
        insertIndex = i + 1;
        closestPoint = point;
      }
    }

    if (minDistance < 20 && closestPoint && insertIndex !== -1) {
      const newVertices = [...vertices];
      newVertices.splice(insertIndex, 0, closestPoint);
      
      polygon.setLatLngs(newVertices);
      setPoints(newVertices);
      
      updateAreaSize(L.GeometryUtil.geodesicArea(newVertices));
      addDraggableVertexMarkers(newVertices);
      updateDistanceMarkers(newVertices);

      const cornerCount = document.querySelector('.corner-count');
      if (cornerCount) {
        cornerCount.textContent = String(newVertices.length);
      }
    }
  };

  // Add useEffect for map initialization to add click handler
  useEffect(() => {
    if (!mapRef.current || !drawnItemsRef.current) return;

    const map = mapRef.current;
    const drawnItems = drawnItemsRef.current;

    // Add click handler to polygon
    const addPolygonClickHandler = () => {
      drawnItems.eachLayer((layer) => {
        if (layer instanceof L.Polygon) {
          layer.on('click', handleEdgeClick);
        }
      });
    };

    // Add handler to existing polygon
    addPolygonClickHandler();

    // Add handler when new polygon is created
    drawnItems.on('layeradd', addPolygonClickHandler);

    return () => {
      drawnItems.eachLayer((layer) => {
        if (layer instanceof L.Polygon) {
          layer.off('click', handleEdgeClick);
        }
      });
      drawnItems.off('layeradd', addPolygonClickHandler);
    };
  }, []);

  // Add handleSave function before the return statement
  const handleSave = () => {
    if (!drawnItemsRef.current || points.length < 3) return;

    try {
      const layers = drawnItemsRef.current.getLayers();
      if (layers.length === 0) return;

      const polygon = layers[0] as L.Polygon;
      const vertices = polygon.getLatLngs()[0] as L.LatLng[];
      
      // Calculate area
      const area = L.GeometryUtil.geodesicArea(vertices);
      
      // Calculate perimeter
      let perimeter = 0;
      for (let i = 0; i < vertices.length; i++) {
        const start = vertices[i];
        const end = vertices[(i + 1) % vertices.length];
        perimeter += start.distanceTo(end);
      }

      // Create field boundary object
      const fieldBoundary = {
        vertices: vertices.map(v => ({ lat: v.lat, lng: v.lng })),
        area: area,
        perimeter: perimeter
      };

      // Convert to JSON string
      const jsonData = JSON.stringify(fieldBoundary, null, 2);
      
      // Create blob and download link
      const blob = new Blob([jsonData], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `field_boundary_${new Date().toISOString().split('T')[0]}.json`;
      
      // Trigger download
      document.body.appendChild(link);
      link.click();
      
      // Cleanup
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      // Optional: Show success message
      alert('Field boundary saved successfully!');

    } catch (error) {
      console.error('Error saving field boundary:', error);
      alert('Failed to save field boundary. Please try again.');
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* Top Bar - Search and Layer Controls */}
      <div className="absolute top-0 left-0 right-0 z-[1000] bg-white/90 backdrop-blur-sm shadow-lg p-2 sm:p-4">
        <div className="flex items-center justify-between max-w-screen-xl mx-auto">
          {/* Search Section */}
          <div className="relative flex-1 max-w-md">
            <div className="flex items-center bg-gray-50 rounded-full px-3 py-2">
              <FaSearch className="text-gray-400 mr-2" />
              <input
                type="text"
                placeholder="Search location..."
                className="bg-transparent w-full outline-none text-sm"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            {/* Search Results Dropdown */}
            {searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-lg shadow-lg max-h-60 overflow-y-auto">
                {searchResults.map((result, index) => (
                  <button
                    key={index}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50"
                    onClick={() => handleResultClick(result)}
                  >
                    {result.display_name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Layer Toggle */}
          <button
            onClick={cycleMapLayer}
            className="ml-2 p-2 rounded-full bg-white shadow-md hover:bg-gray-50"
          >
            <FaLayerGroup className="text-gray-600" />
          </button>
        </div>
      </div>

      {/* Map Container */}
      <div ref={mapContainerRef} className="flex-1 w-full h-full" />

      {/* Bottom Controls Panel */}
      <div className="absolute bottom-0 left-0 right-0 z-[1000] bg-white/90 backdrop-blur-sm shadow-lg">
        {/* Stats Bar */}
        <div className="flex items-center justify-between p-2 border-b">
          {/* Area Display */}
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-500">Area:</span>
            <span className="text-sm font-semibold">{areaSize}</span>
            <select
              className="text-sm bg-gray-50 border rounded px-1 py-0.5 outline-none"
              value={selectedUnit}
              onChange={(e) => {
                setSelectedUnit(e.target.value as MeasurementUnit);
                const layers = drawnItemsRef.current?.getLayers() || [];
                if (layers.length > 0) {
                  const polygon = layers[layers.length - 1] as L.Polygon;
                  const vertices = polygon.getLatLngs()[0] as L.LatLng[];
                  updateAreaSize(L.GeometryUtil.geodesicArea(vertices));
                }
              }}
            >
              <option value="ha">ha</option>
              <option value="sqm">m²</option>
              <option value="acre">ac</option>
              <option value="sqft">ft²</option>
            </select>
          </div>

          {/* Corners Counter */}
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-500">Corners:</span>
            <span className="text-sm font-semibold">
              {(() => {
                const layers = drawnItemsRef.current?.getLayers() || [];
                if (layers.length > 0) {
                  const polygon = layers[layers.length - 1] as L.Polygon;
                  const vertices = polygon.getLatLngs()[0] as L.LatLng[];
                  return vertices.length;
                }
                return 0;
              })()}
            </span>
          </div>
        </div>

        {/* Tools Grid */}
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-1 p-2">
          {/* Drawing Tool */}
          <button
            onClick={() => setIsDrawing(!isDrawing)}
            className={`flex flex-col items-center justify-center p-2 rounded-lg ${
              isDrawing ? 'bg-blue-50 text-blue-600' : 'hover:bg-gray-50'
            }`}
          >
            <FaPen className="text-lg mb-1" />
            <span className="text-xs">Draw</span>
          </button>

          {/* Edit Vertices */}
          <button
            onClick={enableVertexEditing}
            className={`flex flex-col items-center justify-center p-2 rounded-lg ${
              isEditingVertices ? 'bg-blue-50 text-blue-600' : 'hover:bg-gray-50'
            }`}
          >
            <FaEdit className="text-lg mb-1" />
            <span className="text-xs">Edit</span>
          </button>

          {/* Undo */}
          <button
            onClick={handleUndo}
            disabled={points.length === 0}
            className="flex flex-col items-center justify-center p-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <FaUndo className="text-lg mb-1" />
            <span className="text-xs">Undo</span>
          </button>

          {/* Redo */}
          <button
            onClick={handleRedo}
            disabled={redoStack.length === 0}
            className="flex flex-col items-center justify-center p-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <FaRedo className="text-lg mb-1" />
            <span className="text-xs">Redo</span>
          </button>

          {/* GPS */}
          <button
            onClick={toggleGPS}
            className={`flex flex-col items-center justify-center p-2 rounded-lg ${
              gpsStatus !== 'inactive' ? 'bg-blue-50 text-blue-600' : 'hover:bg-gray-50'
            }`}
          >
            {gpsStatus === 'searching' ? (
              <MdGpsNotFixed className="text-lg mb-1 animate-pulse" />
            ) : gpsStatus === 'active' ? (
              <MdGpsFixed className="text-lg mb-1" />
            ) : (
              <FaLocationArrow className="text-lg mb-1" />
            )}
            <span className="text-xs">GPS</span>
          </button>

          {/* Elevation Analysis */}
          <button
            onClick={() => setShowElevationAnalysis(true)}
            disabled={!apiKey || points.length < 3}
            className="flex flex-col items-center justify-center p-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <FaChartArea className="text-lg mb-1" />
            <span className="text-xs">Elevation</span>
          </button>

          {/* Clear */}
          <button
            onClick={handleDelete}
            disabled={points.length === 0}
            className="flex flex-col items-center justify-center p-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <FaTrash className="text-lg mb-1" />
            <span className="text-xs">Clear</span>
          </button>

          {/* Save */}
          <button
            onClick={handleSave}
            disabled={points.length < 3}
            className="flex flex-col items-center justify-center p-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <FaSave className="text-lg mb-1" />
            <span className="text-xs">Save</span>
          </button>
        </div>
      </div>

      {/* Loading Overlay */}
      {isAnalyzing && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-[2000]">
          <div className="bg-white p-4 rounded-lg shadow-lg">
            <div className="animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full mb-2 mx-auto"></div>
            <p className="text-sm text-center">Analyzing elevation...</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default Map;