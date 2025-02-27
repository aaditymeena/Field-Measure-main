export function interpolateColor(color1: string, color2: string, ratio: number): string {
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
} 