import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { points, apiKey } = req.body;

    if (!points || !Array.isArray(points) || points.length === 0) {
      return res.status(400).json({ message: 'Invalid points data' });
    }

    if (!apiKey) {
      return res.status(400).json({ message: 'API key is required' });
    }

    // Format points for Google API
    const locations = points.map(p => `${p.lat},${p.lng}`).join('|');
    
    // Call Google Maps Elevation API
    const url = `https://maps.googleapis.com/maps/api/elevation/json?locations=${locations}&key=${apiKey}`;
    
    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' && data.results) {
      return res.status(200).json(data);
    } else {
      console.error('Google API Error:', data);
      return res.status(500).json({ 
        message: 'Failed to get elevation data',
        error: data.error_message || 'Unknown error'
      });
    }

  } catch (error) {
    console.error('Elevation API error:', error);
    return res.status(500).json({ 
      message: 'Failed to fetch elevation data',
      error: error.message 
    });
  }
}