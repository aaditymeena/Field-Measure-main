import { useState } from 'react';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import type { NextPage } from 'next';

// Dynamically import the Map component to avoid SSR issues with Leaflet
const Map = dynamic(() => import('../components/Map'), {
  ssr: false,
  loading: () => <div>Loading map...</div>
});

const Home: NextPage = () => {
  const [area, setArea] = useState<number>(0);

  const handleAreaUpdate = (newArea: number) => {
    setArea(newArea);
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <Head>
        <title>Field Area Measurement System</title>
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.7.1/dist/leaflet.css"
        />
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.css"
        />
      </Head>

      <main className="container mx-auto px-4 py-8">
        <h1 className="text-4xl font-bold mb-8">Field Area Measurement System</h1>
        
        <div className="bg-white rounded-lg shadow-lg p-6">
          <Map onAreaUpdate={handleAreaUpdate} />
          
          <div className="mt-4">
            <h2 className="text-xl font-semibold">Measured Area:</h2>
            <p className="text-2xl">
              {(area / 10000).toFixed(2)} hectares
              ({area.toFixed(2)} square meters)
            </p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Home; 