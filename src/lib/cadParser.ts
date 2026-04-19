import { ImportedPoint } from './ncnParser';
// @ts-ignore
import DxfParser from 'dxf-parser';

export const parseDXF = (fileContent: string): ImportedPoint[] => {
  const parser = new DxfParser();
  try {
    const dxf = parser.parseSync(fileContent);
    const points: ImportedPoint[] = [];

    if (dxf.entities) {
      dxf.entities.forEach((entity: any, index: number) => {
        if (entity.type === 'POINT') {
          points.push({
            name: `P${index + 1}-DXF`,
            lon: entity.position.x,
            lat: entity.position.y,
            alt: entity.position.z || 0
          });
        } else if (entity.type === 'TEXT') {
          points.push({
            name: entity.text || `T${index + 1}`,
            lon: entity.position.x,
            lat: entity.position.y,
            alt: entity.position.z || 0
          });
        }
      });
    }
    return points;
  } catch (error) {
    console.error("DXF Parse Error:", error);
    throw new Error("DXF Okuma hatası");
  }
};
