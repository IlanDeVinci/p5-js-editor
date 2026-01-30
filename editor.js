/* Minimal p5-based editor
 - Keeps scene as JSON-backed model: shapes have type, props, transform, id
 - Supports: add ellipse/rect/polygon, select/move, vertex edit, group/ungroup, import/export, edit JSON
 - Not all possible p5 commands can be captured generically; we store a "draw" instruction list per-shape (array of primitive commands)
 - This implementation captures common primitives (ellipse, rect, beginShape/vertex/endShape, arc, line) expressed as objects and replays them using p5 drawing calls.
*/

let editor; // will hold instance

// Utility: generate short ids
function uid(prefix = "id") {
  return prefix + "_" + Math.random().toString(36).slice(2, 9);
}

class Shape {
  constructor(data = {}) {
    this.id = data.id || uid("s");
    this.type = data.type || "shape";
    this.x = data.x || 0;
    this.y = data.y || 0;
    this.rotation = data.rotation || 0;
    this.scale = data.scale || 1;
    this.fill = data.fill || "#ffebdd";
    this.stroke = data.stroke || "#362f38";
    // allow explicit 0 strokeWeight (means no stroke)
    this.strokeWeight = data.strokeWeight !== undefined ? data.strokeWeight : 2;
    this.visible = data.visible !== undefined ? data.visible : true;
    this.commands = data.commands || [];
    this.vertices = data.vertices || null;
    this.name = data.name || "";
    // UI-only states persisted on layers
    this._opacity = data._opacity !== undefined ? data._opacity : 1;
    this._locked = data._locked !== undefined ? data._locked : false;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      scale: this.scale,
      fill: this.fill,
      stroke: this.stroke,
      strokeWeight: this.strokeWeight,
      visible: this.visible,
      // deep-clone arrays to avoid sharing references when duplicating / serializing
      commands: this.commands
        ? this.commands.map((c) => JSON.parse(JSON.stringify(c)))
        : [],
      vertices: this.vertices
        ? this.vertices.map((v) => ({ x: v.x, y: v.y }))
        : null,
      name: this.name,
      _opacity: this._opacity,
      _locked: this._locked,
    };
  }

  // Hit test using inverse transform into local coordinates
  hitTest(px, py) {
    let lx = px - this.x;
    let ly = py - this.y;
    if (this.scale && this.scale !== 1) {
      lx /= this.scale;
      ly /= this.scale;
    }
    if (this.rotation) {
      const ca = Math.cos(-this.rotation);
      const sa = Math.sin(-this.rotation);
      const nx = lx * ca - ly * sa;
      const ny = lx * sa + ly * ca;
      lx = nx;
      ly = ny;
    }
    const b = this._computeBounds();
    if (!b) return false;
    return lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h;
  }

  _computeBounds() {
    const pts = [];
    if (this.vertices && this.vertices.length) {
      this.vertices.forEach((p) => pts.push({ x: p.x, y: p.y }));
    } else {
      this.commands.forEach((c) => {
        if (c.type === "ellipse") {
          pts.push({
            x: c.x + (c.w ? c.w / 2 : 0),
            y: c.y + (c.h ? c.h / 2 : 0),
          });
          pts.push({
            x: c.x - (c.w ? c.w / 2 : 0),
            y: c.y - (c.h ? c.h / 2 : 0),
          });
        } else if (c.type === "rect") {
          // rect may be stored in center mode (default for editor-created rects) or corner mode (imported sketches)
          if (c.mode === "corner") {
            pts.push({ x: c.x, y: c.y });
            pts.push({ x: c.x + c.w, y: c.y + c.h });
          } else {
            pts.push({
              x: c.x + (c.w ? c.w / 2 : 0),
              y: c.y + (c.h ? c.h / 2 : 0),
            });
            pts.push({
              x: c.x - (c.w ? c.w / 2 : 0),
              y: c.y - (c.h ? c.h / 2 : 0),
            });
          }
        } else if (c.type === "arc") {
          pts.push({
            x: c.x + (c.w ? c.w / 2 : 0),
            y: c.y + (c.h ? c.h / 2 : 0),
          });
          pts.push({
            x: c.x - (c.w ? c.w / 2 : 0),
            y: c.y - (c.h ? c.h / 2 : 0),
          });
        } else if (c.type === "vertex") {
          pts.push({ x: c.x, y: c.y });
        } else if (c.type === "text") {
          // approximate text bounds: use size as height and estimate width by avg char width
          const size = c.size || 24;
          const content = String(c.content || "");
          const avgChar = 0.6; // avg width factor relative to font size
          const w = Math.max(4, content.length * size * avgChar);
          const h = size;
          // respect textAlign/baseline similar to drawing: default is CENTER/CENTER
          const align = c.align || null;
          const baseline = c.baseline || null;
          let left = c.x - w / 2;
          let top = c.y - h / 2;
          if (align === "left") left = c.x;
          else if (align === "right") left = c.x - w;
          if (baseline === "top") top = c.y;
          else if (baseline === "bottom") top = c.y - h;
          pts.push({ x: left, y: top });
          pts.push({ x: left + w, y: top + h });
        } else if (c.type === "line") {
          pts.push({ x: c.x1, y: c.y1 });
          pts.push({ x: c.x2, y: c.y2 });
        } else if (c.type === "bezier") {
          // approximate bezier bounds via its control points
          pts.push({ x: c.x1, y: c.y1 });
          pts.push({ x: c.x2, y: c.y2 });
          pts.push({ x: c.x3, y: c.y3 });
          pts.push({ x: c.x4, y: c.y4 });
        }
      });
    }
    if (!pts.length) return null;
    const minx = Math.min(...pts.map((p) => p.x));
    const miny = Math.min(...pts.map((p) => p.y));
    const maxx = Math.max(...pts.map((p) => p.x));
    const maxy = Math.max(...pts.map((p) => p.y));
    return { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
  }

  draw(p) {
    if (this.visible === false) return;
    p.push();
    p.translate(this.x, this.y);
    p.rotate(this.rotation);
    p.scale(this.scale);
    // if polygon rings present (from boolean ops), draw with support for holes using contours
    if (this._polyRings && this._polyRings.length) {
      // apply fill/stroke manually via p5's beginShape/contour API
      try {
        // set fill and stroke
        if (this.fill) {
          const cf = this._col(this.fill);
          if (Array.isArray(cf)) p.fill(cf[0], cf[1], cf[2], cf[3] || 255);
          else p.fill(cf);
        } else p.noFill();
        if (this.stroke && this.strokeWeight !== 0) {
          const cs = this._col(this.stroke);
          if (Array.isArray(cs)) p.stroke(cs[0], cs[1], cs[2], cs[3] || 255);
          else p.stroke(cs);
          p.strokeWeight(this.strokeWeight || 1);
        } else p.noStroke();
        // polyRings is an array where first is outer ring, subsequent are holes
        p.beginShape();
        const outer = this._polyRings[0];
        for (const pt of outer) p.vertex(pt[0], pt[1]);
        // draw holes as contours
        for (let h = 1; h < this._polyRings.length; h++) {
          const hole = this._polyRings[h];
          p.beginContour();
          for (const pt of hole) p.vertex(pt[0], pt[1]);
          p.endContour();
        }
        p.endShape(p.CLOSE);
      } catch (e) {
        // fallback to normal drawing
      }
      p.pop();
      return;
    }
    // apply per-layer opacity via canvas globalAlpha so all drawing respects it
    try {
      const ctx = p.drawingContext;
      if (ctx && this._opacity !== undefined && this._opacity !== 1) {
        ctx.globalAlpha = (ctx.globalAlpha || 1) * this._opacity;
      }
    } catch (e) {}
    // Resolve fill/stroke to numeric calls when possible so colors from parsed sketches render correctly
    const applyFill = (col) => {
      if (!col) return p.noFill();
      const c = this._col(col);
      if (Array.isArray(c)) {
        if (c.length === 3) p.fill(c[0], c[1], c[2]);
        else if (c.length === 4) p.fill(c[0], c[1], c[2], c[3]);
        else p.fill(col);
      } else p.fill(col);
    };
    const applyStroke = (col) => {
      // if stroke color missing or weight is 0 treat as noStroke
      if (!col || this.strokeWeight === 0) return p.noStroke();
      const c = this._col(col);
      if (Array.isArray(c)) {
        if (c.length === 3) p.stroke(c[0], c[1], c[2]);
        else if (c.length === 4) p.stroke(c[0], c[1], c[2], c[3]);
        else p.stroke(col);
      } else p.stroke(col);
      p.strokeWeight(this.strokeWeight);
    };
    applyFill(this.fill);
    applyStroke(this.stroke);
    if (this.vertices && this.vertices.length) {
      p.beginShape();
      this.vertices.forEach((v) => p.vertex(v.x, v.y));
      p.endShape(p.CLOSE);
    } else {
      this.commands.forEach((c) => {
        switch (c.type) {
          case "ellipse":
            p.ellipse(c.x, c.y, c.w, c.h);
            break;
          case "rect":
            // respect rect mode when present (corner vs center)
            if (c.mode === "corner") {
              p.rectMode(p.CORNER);
              p.rect(c.x, c.y, c.w, c.h);
              p.rectMode(p.CORNER);
            } else {
              p.rectMode(p.CENTER);
              p.rect(c.x, c.y, c.w, c.h);
              p.rectMode(p.CORNER);
            }
            break;
          case "text":
            p.push();
            p.noStroke();
            p.fill(this._col(this.fill));
            p.textAlign(c.align || p.CENTER, c.baseline || p.CENTER);
            p.textSize(c.size || 24);
            p.text(c.content || "", c.x, c.y);
            p.pop();
            break;
          case "image":
            if (c.imgInstance) {
              p.imageMode(p.CENTER);
              p.image(
                c.imgInstance,
                c.x,
                c.y,
                c.w || c.imgInstance.width,
                c.h || c.imgInstance.height
              );
            }
            break;
          case "line":
            p.line(c.x1, c.y1, c.x2, c.y2);
            break;
          case "arc":
            p.arc(c.x, c.y, c.w, c.h, c.start, c.end);
            break;
          case "bezier":
            p.bezier(c.x1, c.y1, c.x2, c.y2, c.x3, c.y3, c.x4, c.y4);
            break;
          case "beginShape":
            p.beginShape();
            break;
          case "vertex":
            p.vertex(c.x, c.y);
            break;
          case "endShape":
            p.endShape(c.mode || p.CLOSE);
            break;
          default:
            break;
        }
      });
    }
    p.pop();
  }

  _col(c) {
    if (typeof c === "string") {
      // try rgb(...) or rgba(...) formats
      const rgbm = c.match(
        /rgba?\s*\(\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*,\s*([0-9\.]+)(?:\s*,\s*([0-9\.]+)\s*)?\)/i
      );
      if (rgbm) {
        const r = parseFloat(rgbm[1]);
        const g = parseFloat(rgbm[2]);
        const b = parseFloat(rgbm[3]);
        if (rgbm[4] !== undefined) return [r, g, b, parseFloat(rgbm[4])];
        return [r, g, b];
      }
      return c;
    }
    if (Array.isArray(c)) return c;
    return c;
  }
}

// Add color expression evaluator and helper to Editor class via prototype methods

class Group {
  constructor(data = {}) {
    this.id = data.id || uid("g");
    this.type = "group";
    this.children = (data.children || []).map((ch) =>
      ch.type === "group" ? new Group(ch) : new Shape(ch)
    );
    this.x = data.x || 0;
    this.y = data.y || 0;
    this.rotation = data.rotation || 0;
    this.scale = data.scale || 1;
    this.name = data.name || "";
    this.visible = data.visible !== undefined ? data.visible : true;
  }
  toJSON() {
    return {
      id: this.id,
      type: "group",
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      scale: this.scale,
      visible: this.visible,
      name: this.name,
      children: this.children.map((c) => c.toJSON()),
    };
  }
  hitTest(px, py) {
    if (this.visible === false) return false;
    // transform point into group local coords and test children
    let tx = px - this.x;
    let ty = py - this.y;
    // account for group's rotation and scale by inverse transforming the point
    if (this.scale && this.scale !== 1) {
      tx /= this.scale;
      ty /= this.scale;
    }
    if (this.rotation) {
      const ca = Math.cos(-this.rotation);
      const sa = Math.sin(-this.rotation);
      const nx = tx * ca - ty * sa;
      const ny = tx * sa + ty * ca;
      tx = nx;
      ty = ny;
    }
    for (let i = this.children.length - 1; i >= 0; i--) {
      if (this.children[i].hitTest(tx, ty)) return true;
    }
    return false;
  }
  draw(p) {
    if (this.visible === false) return;
    p.push();
    p.translate(this.x, this.y);
    p.rotate(this.rotation);
    p.scale(this.scale);
    this.children.forEach((c) => c.draw(p));
    p.pop();
  }
}

class Editor {
  constructor(p) {
    this.p = p;
    this.scene = []; // array of Shape or Group
    this.selected = []; // selected items (references)
    this.mode = "select"; // or 'vertex'
    this.dragging = false;
    this.dragStart = null;
    this.vertexDrag = null; // {shape, index}
    this._selectedVertex = null; // {shape, index}
    this._selectedCmdPoint = null; // {shape, cmdIndex, xProp, yProp}
    this._hoverVertex = null; // {shape, index, x, y}
    this._hoverEdge = null; // {shape, i, ax, ay, bx, by, px, py}
    this.history = [];
    this.future = [];
    this.layerListEl = null;
    this.imagesCache = {};
    this.transformDrag = null; // {type, target, origin, start...}
    this.movedDuringInteraction = false;
    this.marqueeActive = false;
    this.marquee = null; // {x0,y0,x1,y1} in centered coords
    this.pipetteMode = false;
    this.palette = [];
    this._marqueeDashOffset = 0;
    this._marqueeAnimating = false;
    // which swatch is the target for pipette actions: 'primary' | 'secondary' | 'palette-idx'
    this._pipetteTarget = null;
    // which UI color target is currently selected for edits/pipette: 'primary' | 'secondary' | 'fill' | 'stroke' | 'palette-N'
    this._selectedColorTarget = null;
    // for cycling through overlapping hits when clicking repeatedly
    this._lastHitCycle = { ids: [], pos: 0, mx: null, my: null };
    // history coalescing: during continuous interactions (drag, arrow keys), avoid pushing many entries
    this._coalescing = false;
    this._coalesceTimer = null;
    this.gridVisible = false; // new property for grid visibility

    // draw tools (line / bezier)
    // - line: click+drag to set endpoints
    // - bezier: click 4 points (start, control1, control2, end)
    this.drawTool = {
      kind: null, // 'line' | 'bezier'
      active: false,
      points: [],
      start: null,
      current: null,
      cursor: null,
    };

    // UI elements will be wired externally after setup
  }

  // round numeric values of selected shapes
  // round numeric values of selected shapes
  // mode: 'int' -> nearest integer, '5' -> nearest multiple of 5, '0.1' -> nearest 0.1, '0.01' -> nearest 0.01
  roundUpSelected(mode = "int") {
    const makeRounder = (m) => {
      return (v) => {
        if (typeof v !== "number") return v;
        if (m === "5") return Math.round(v / 5) * 5;
        if (m === "0.1") return Math.round(v * 10) / 10;
        if (m === "0.01") return Math.round(v * 100) / 100;
        // default integer
        return Math.round(v);
      };
    };
    const rounder = makeRounder(mode);
    this.selected.forEach((s) => {
      // round simple transform props
      if (s.x !== undefined) s.x = rounder(s.x);
      if (s.y !== undefined) s.y = rounder(s.y);
      if (s.rotation !== undefined) s.rotation = rounder(s.rotation);
      if (s.scale !== undefined) {
        // special-case scale: prefer fine-grain for very small values, coarser for normal
        const sc = s.scale;
        const abs = Math.abs(sc);
        if (mode === "0.01" || mode === "0.1") {
          // if user explicitly requested small quantums, use that
          s.scale = makeRounder(mode)(sc);
        } else {
          // otherwise pick sensible default: nearest 0.01 for very small scales, 0.1 for typical ranges
          if (abs < 0.2) s.scale = Math.round(sc * 100) / 100;
          else if (abs < 2) s.scale = Math.round(sc * 10) / 10;
          else s.scale = rounder(sc);
        }
      }
      if (s.strokeWeight !== undefined)
        s.strokeWeight = rounder(s.strokeWeight);
      // round vertices if present
      if (s.vertices && Array.isArray(s.vertices)) {
        s.vertices.forEach((v) => {
          if (v.x !== undefined) v.x = rounder(v.x);
          if (v.y !== undefined) v.y = rounder(v.y);
        });
      }
      // round command params
      if (s.commands && Array.isArray(s.commands)) {
        s.commands.forEach((c) => {
          if (c.x !== undefined) c.x = rounder(c.x);
          if (c.y !== undefined) c.y = rounder(c.y);
          if (c.w !== undefined) c.w = rounder(c.w);
          if (c.h !== undefined) c.h = rounder(c.h);
          if (c.size !== undefined) c.size = rounder(c.size);
        });
      }
    });
    this.pushHistory();
  }

  // return an array of world-space vertices for a shape when possible
  _getWorldVertices(shape) {
    // for groups, return null to fall back to bbox
    if (!shape || shape.type === "group") return null;
    const verts = [];
    // helper to transform local point by shape transform
    const transformPoint = (x, y) => {
      let nx = x;
      let ny = y;
      if (shape.scale && shape.scale !== 1) {
        nx *= shape.scale;
        ny *= shape.scale;
      }
      if (shape.rotation) {
        const ca = Math.cos(shape.rotation);
        const sa = Math.sin(shape.rotation);
        const rx = nx * ca - ny * sa;
        const ry = nx * sa + ny * ca;
        nx = rx;
        ny = ry;
      }
      return { x: nx + (shape.x || 0), y: ny + (shape.y || 0) };
    };

    if (shape.vertices && shape.vertices.length) {
      shape.vertices.forEach((v) => verts.push(transformPoint(v.x, v.y)));
      return verts;
    }
    // collect vertices from commands where possible
    if (shape.commands && shape.commands.length) {
      for (const c of shape.commands) {
        if (c.type === "rect") {
          if (c.mode === "corner") {
            verts.push(transformPoint(c.x, c.y));
            verts.push(transformPoint(c.x + c.w, c.y));
            verts.push(transformPoint(c.x + c.w, c.y + c.h));
            verts.push(transformPoint(c.x, c.y + c.h));
          } else {
            // center mode
            const hw = (c.w || 0) / 2;
            const hh = (c.h || 0) / 2;
            verts.push(transformPoint(c.x - hw, c.y - hh));
            verts.push(transformPoint(c.x + hw, c.y - hh));
            verts.push(transformPoint(c.x + hw, c.y + hh));
            verts.push(transformPoint(c.x - hw, c.y + hh));
          }
        } else if (c.type === "vertex") {
          verts.push(transformPoint(c.x, c.y));
        } else if (c.type === "image") {
          // image behaves like a centered rect with w/h
          const w = c.w || (c.imgInstance ? c.imgInstance.width : 100);
          const h = c.h || (c.imgInstance ? c.imgInstance.height : 100);
          verts.push(transformPoint(c.x - w / 2, c.y - h / 2));
          verts.push(transformPoint(c.x + w / 2, c.y + h / 2));
        } else if (c.type === "text") {
          const size = c.size || 24;
          const content = String(c.content || "");
          const avgChar = 0.6;
          const w = Math.max(4, content.length * size * avgChar);
          const h = size;
          const align = c.align || null;
          const baseline = c.baseline || null;
          let left = c.x - w / 2;
          let top = c.y - h / 2;
          if (align === "left") left = c.x;
          else if (align === "right") left = c.x - w;
          if (baseline === "top") top = c.y;
          else if (baseline === "bottom") top = c.y - h;
          verts.push(transformPoint(left, top));
          verts.push(transformPoint(left + w, top + h));
        } else if (c.type === "ellipse") {
          // approximate ellipse by polygon
          const rx = (c.w || 0) / 2;
          const ry = (c.h || 0) / 2;
          const steps = 12;
          for (let i = 0; i < steps; i++) {
            const t = (i / steps) * Math.PI * 2;
            const lx = c.x + Math.cos(t) * rx;
            const ly = c.y + Math.sin(t) * ry;
            verts.push(transformPoint(lx, ly));
          }
        }
      }
      if (verts.length) return verts;
    }
    return null;
  }

  // test whether all vertices of shape are inside rect (rx,ry,rw,rh)
  _isShapeFullyContained(shape, rx, ry, rw, rh) {
    const verts = this._getWorldVertices(shape);
    if (!verts) {
      // fallback to bbox containment
      const b =
        shape.type === "group"
          ? this._groupBounds(shape)
          : shape._computeBounds();
      if (!b) return false;
      const bx = (shape.x || 0) + b.x;
      const by = (shape.y || 0) + b.y;
      return bx >= rx && by >= ry && bx + b.w <= rx + rw && by + b.h <= ry + rh;
    }
    return verts.every(
      (v) => v.x >= rx && v.x <= rx + rw && v.y >= ry && v.y <= ry + rh
    );
  }

  addShape(shape) {
    this.scene.push(shape);
    this.pushHistory();
    return shape;
  }

  removeShapeById(id) {
    this.scene = this.scene.filter((s) => s.id !== id);
    this.pushHistory();
  }

  findAt(x, y) {
    for (let i = this.scene.length - 1; i >= 0; i--) {
      const s = this.scene[i];
      // hitTest expects global (centered) coords
      if (s.hitTest(x, y)) return s;
    }
    return null;
  }

  // find all items hit at a point, ordered top-first
  findAllAt(x, y) {
    const hits = [];
    for (let i = this.scene.length - 1; i >= 0; i--) {
      const s = this.scene[i];
      if (s.hitTest && s.hitTest(x, y)) hits.push(s);
    }
    return hits;
  }

  clearSelection() {
    this.selected = [];
  }
  select(shape, multi = false) {
    if (!multi) this.clearSelection();
    if (!this.selected.includes(shape)) this.selected.push(shape);
    // reflect selection in layer list immediately
    if (this.layerListEl) this._renderLayerList();
    // scroll first selected into view in layer list
    if (this.layerListEl && this.selected.length) {
      // find the corresponding child element by matching id text
      const nodes = Array.from(
        this.layerListEl.querySelectorAll(".layer-item")
      );
      for (const n of nodes) {
        if (
          n.textContent &&
          n.textContent.indexOf(this.selected[0].id) !== -1
        ) {
          setTimeout(
            () => n.scrollIntoView({ block: "nearest", behavior: "smooth" }),
            0
          );
          break;
        }
      }
    }
  }

  duplicateSelection() {
    if (!this.selected.length) return;
    const newItems = [];
    this.selected.forEach((s) => {
      // perform a deep clone of the shape/group data to avoid sharing
      const raw = JSON.parse(JSON.stringify(s.toJSON()));
      // assign new id and offset position on clone
      raw.id = uid("s");
      if (raw.x !== undefined) raw.x = raw.x + 10;
      if (raw.y !== undefined) raw.y = raw.y + 10;
      // if group clone each child and assign new ids
      if (raw.type === "group" && Array.isArray(raw.children)) {
        raw.children = raw.children.map((c) => {
          const nc = JSON.parse(JSON.stringify(c));
          nc.id = uid("s");
          if (nc.x !== undefined) nc.x = nc.x + 10;
          if (nc.y !== undefined) nc.y = nc.y + 10;
          return nc;
        });
        const g = new Group(raw);
        this.scene.push(g);
        newItems.push(g);
      } else {
        const sh = new Shape(raw);
        this.scene.push(sh);
        newItems.push(sh);
      }
    });
    this.clearSelection();
    newItems.forEach((n) => this.select(n, true));
    this.pushHistory();
  }

  // Convert a Shape's polygon-like data to polygon-clipping compatible rings (array of rings, each ring is array of [x,y])
  _shapeToPolygonRings(shape) {
    // prefer explicit vertices if present
    const rings = [];
    if (!shape) return rings;
    if (shape.vertices && shape.vertices.length) {
      const ring = shape.vertices.map((v) => [
        v.x + (shape.x || 0),
        v.y + (shape.y || 0),
      ]);
      rings.push(ring);
      return rings;
    }
    // try to extract from commands beginShape/vertex/endShape or rect/ellipse (approximate ellipse by polygon)
    if (shape.commands && shape.commands.length) {
      let current = [];
      for (const c of shape.commands) {
        if (c.type === "vertex") {
          current.push([c.x + (shape.x || 0), c.y + (shape.y || 0)]);
        } else if (c.type === "beginShape") {
          current = [];
        } else if (c.type === "endShape") {
          if (current.length) rings.push(current.slice());
          current = [];
        } else if (c.type === "rect") {
          const rx =
            (shape.x || 0) + (c.mode === "corner" ? c.x : c.x - (c.w || 0) / 2);
          const ry =
            (shape.y || 0) + (c.mode === "corner" ? c.y : c.y - (c.h || 0) / 2);
          const rw = c.w || 0;
          const rh = c.h || 0;
          rings.push([
            [rx, ry],
            [rx + rw, ry],
            [rx + rw, ry + rh],
            [rx, ry + rh],
          ]);
        } else if (c.type === "ellipse") {
          // approximate ellipse
          const cx = (shape.x || 0) + c.x;
          const cy = (shape.y || 0) + c.y;
          const rx = (c.w || 0) / 2;
          const ry = (c.h || 0) / 2;
          const steps = 20;
          const poly = [];
          for (let i = 0; i < steps; i++) {
            const t = (i / steps) * Math.PI * 2;
            poly.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
          }
          rings.push(poly);
        }
      }
      if (current.length) rings.push(current.slice());
    }
    return rings;
  }

  // Convert polygon-clipping result (array of rings) to a Shape with vertices (first ring outer, others holes are ignored for now)
  _polygonRingsToShape(rings, opts = {}) {
    if (!rings || !rings.length) return null;
    // polygon-clipping can return MultiPolygon structure: array of polygons each an array of rings
    // Flatten to first polygon's outer ring
    let outer = null;
    if (Array.isArray(rings[0][0])) {
      // MultiPolygon: take first polygon's first ring
      outer = rings[0][0];
    } else {
      outer = rings[0];
    }
    if (!outer || !outer.length) return null;
    const verts = outer.map((p) => ({ x: p[0], y: p[1] }));
    const s = new Shape({
      x: 0,
      y: 0,
      vertices: verts,
      fill: opts.fill || "#ffebdd",
      stroke: opts.stroke || "#362f38",
    });
    return s;
  }

  // Perform boolean operation (union/diff/intersect/xor) on two selected shapes using polygon-clipping library
  performBooleanOp(op) {
    // require exactly two selected shapes
    if (!this.selected || this.selected.length !== 2) return null;
    const a = this.selected[0];
    const b = this.selected[1];
    // convert to rings
    const ra = this._shapeToPolygonRings(a);
    const rb = this._shapeToPolygonRings(b);
    if (!ra.length || !rb.length) return null;
    let res = null;
    try {
      if (op === "union") res = window.polygonClipping.union(ra, rb);
      else if (op === "diff") res = window.polygonClipping.difference(ra, rb);
      else if (op === "intersect")
        res = window.polygonClipping.intersection(ra, rb);
      else if (op === "xor") res = window.polygonClipping.xor(ra, rb);
    } catch (e) {
      console.error("Boolean op failed", e);
      return null;
    }
    if (!res || !res.length) return null;
    // polygon-clipping can return complex MultiPolygon: convert to internal _polyRings format (array of rings)
    // For simplicity, flatten first polygon and keep its rings; if result is multipolygon, pick first polygon
    let chosen = null;
    if (Array.isArray(res[0][0])) {
      // MultiPolygon: res = [ [ [x,y],... ], ... ] or deeper; choose res[0]
      chosen = res[0];
    } else {
      chosen = res;
    }
    if (!chosen) return null;
    // compute centroid to set shape.x/y so that stored vertex coords are relative
    const allPts = [].concat(...chosen);
    const cx = allPts.reduce((s, p) => s + p[0], 0) / allPts.length;
    const cy = allPts.reduce((s, p) => s + p[1], 0) / allPts.length;
    const s = new Shape({
      x: cx,
      y: cy,
      vertices: [],
      fill: a.fill || b.fill || "#ffebdd",
      stroke: a.stroke || b.stroke || "#362f38",
    });
    // set _polyRings as local coords (subtract centroid)
    s._polyRings = chosen.map((ring) =>
      ring.map((p) => [p[0] - cx, p[1] - cy])
    );
    // set editable vertices to outer ring local coords
    const outer = s._polyRings[0] || [];
    s.vertices = outer.map((p) => ({ x: p[0], y: p[1] }));
    this.scene.push(s);
    this.clearSelection();
    this.select(s);
    this.pushHistory();
    return s;
  }

  groupSelected() {
    if (this.selected.length <= 1) return null;
    // remove selected from scene and create group
    // compute bounding box of selection to use as group's origin
    let minx = Infinity,
      miny = Infinity,
      maxx = -Infinity,
      maxy = -Infinity;
    this.selected.forEach((s) => {
      const b = s._computeBounds();
      if (!b) return;
      const sx = s.type === "group" ? s.x + b.x : s.x + b.x;
      const sy = s.type === "group" ? s.y + b.y : s.y + b.y;
      minx = Math.min(minx, sx);
      miny = Math.min(miny, sy);
      maxx = Math.max(maxx, sx + b.w);
      maxy = Math.max(maxy, sy + b.h);
    });
    if (!isFinite(minx)) return null;
    const centerX = (minx + maxx) / 2;
    const centerY = (miny + maxy) / 2;

    const groupChildren = [];
    this.selected.forEach((s) => {
      // remove from scene
      this.scene = this.scene.filter((x) => x.id !== s.id);
      // convert child to JSON and adjust its coordinates to be relative to group center
      const sj = s.toJSON();
      if (sj.x !== undefined) sj.x = sj.x - centerX;
      if (sj.y !== undefined) sj.y = sj.y - centerY;
      // for groups, also children positions should be adjusted (nested groups keep relative offsets)
      if (sj.type === "group" && Array.isArray(sj.children)) {
        sj.children = sj.children.map((c) => {
          if (c.x !== undefined) c.x = c.x - centerX;
          if (c.y !== undefined) c.y = c.y - centerY;
          return c;
        });
      }
      groupChildren.push(sj);
    });
    const g = new Group({ children: groupChildren, x: centerX, y: centerY });
    this.scene.push(g);
    this.clearSelection();
    this.select(g);
    this.pushHistory();
    return g;
  }

  ungroup(shapeGroup) {
    if (shapeGroup.type !== "group") return;
    // remove group and add children to scene, converting their coords back to scene absolute coordinates
    this.scene = this.scene.filter((s) => s.id !== shapeGroup.id);
    shapeGroup.children.forEach((c) => {
      // add group's offset to each child
      if (c.x !== undefined) c.x = c.x + shapeGroup.x;
      if (c.y !== undefined) c.y = c.y + shapeGroup.y;
      if (c.type === "group" && Array.isArray(c.children)) {
        c.children = c.children.map((ch) => {
          if (ch.x !== undefined) ch.x = ch.x + shapeGroup.x;
          if (ch.y !== undefined) ch.y = ch.y + shapeGroup.y;
          return ch;
        });
        this.scene.push(new Group(c));
      } else {
        this.scene.push(new Shape(c));
      }
    });
    this.clearSelection();
    this.pushHistory();
  }

  pushHistory() {
    try {
      const snapshot = JSON.stringify(this.toJSON());
      this.history.push(snapshot);
      if (this.history.length > 120) this.history.shift();
      this.future = [];
      // update layer list UI if present
      if (this.layerListEl) window.updateLayerList();
      // notify history panel if present
      try {
        if (typeof window.updateHistoryPanel === "function")
          window.updateHistoryPanel();
      } catch (e) {}
    } catch (e) {}
  }

  // helpers for coalescing history events so continuous interactions push a single state
  startCoalesce(timeout = 250) {
    // if not already coalescing, push a snapshot of current state as the base for undo
    if (!this._coalescing) {
      try {
        const snap = JSON.stringify(this.toJSON());
        this.history.push(snap);
        if (this.history.length > 120) this.history.shift();
        this.future = [];
      } catch (e) {}
    }
    this._coalescing = true;
    if (this._coalesceTimer) clearTimeout(this._coalesceTimer);
    this._coalesceTimer = setTimeout(() => this.finishCoalesce(), timeout);
  }
  finishCoalesce() {
    if (this._coalesceTimer) clearTimeout(this._coalesceTimer);
    this._coalesceTimer = null;
    this._coalescing = false;
    // push final snapshot
    this.pushHistory();
  }

  undo() {
    if (!this.history.length) return;
    const last = this.history.pop();
    try {
      this.future.push(JSON.stringify(this.toJSON()));
      this.loadJSON(JSON.parse(last));
      if (this.layerListEl) window.updateLayerList();
    } catch (e) {}
  }

  // Called by UI to attach a layer list container element reference
  setLayerListElement(el) {
    this.layerListEl = el;
    if (el) window.updateLayerList = () => this._renderLayerList();
  }

  _renderLayerList() {
    if (!this.layerListEl) return;
    // show items in order (0 bottom -> end top). display top-first for convenience
    this.layerListEl.innerHTML = "";
    // apply search filter if present
    const searchEl = document.getElementById("layer-search");
    const filter =
      searchEl && searchEl.value ? searchEl.value.toLowerCase() : null;
    for (let i = this.scene.length - 1; i >= 0; i--) {
      const item = this.scene[i];
      if (filter) {
        const label = (item.name || item.type || item.id).toLowerCase();
        if (!label.includes(filter)) continue;
      }
      const li = document.createElement("div");
      li.className = "layer-item";
      li.draggable = true;
      li.dataset.index = i;
      li.style.padding = "6px";
      li.style.borderBottom = "1px solid #eee";
      li.style.cursor = "pointer";
      li.style.display = "flex";
      li.style.justifyContent = "space-between";
      li.style.alignItems = "center";
      // left: thumbnail + title
      const thumb = document.createElement("canvas");
      thumb.width = 48;
      thumb.height = 48;
      thumb.style.width = "48px";
      thumb.style.height = "48px";
      thumb.style.marginRight = "8px";
      thumb.style.border = "1px solid #ddd";
      try {
        const ctx = thumb.getContext("2d");
        ctx.clearRect(0, 0, thumb.width, thumb.height);
        // render a simple preview: draw item's bbox filled with its fill color
        const b =
          item.type === "group"
            ? this._groupBounds(item)
            : item._computeBounds();
        if (b) {
          ctx.fillStyle =
            (item.fill &&
              (typeof item.fill === "string" ? item.fill : "#ddd")) ||
            "#fff";
          ctx.fillRect(0, 0, thumb.width, thumb.height);
          ctx.fillStyle =
            (item.stroke &&
              (typeof item.stroke === "string" ? item.stroke : "#888")) ||
            "#888";
          ctx.strokeRect(6, 6, thumb.width - 12, thumb.height - 12);
        }
      } catch (e) {}
      const title = document.createElement("span");
      title.textContent = item.name || item.type;
      // small id below the title
      const idspan = document.createElement("small");
      idspan.textContent = item.id;
      idspan.style.opacity = "0.6";
      idspan.style.fontSize = "12px";
      idspan.style.marginTop = "4px";

      // wrap title + id in a vertical stack so the small appears below the span
      const textWrap = document.createElement("div");
      textWrap.style.display = "flex";
      textWrap.style.flexDirection = "column";
      textWrap.style.justifyContent = "center";
      textWrap.style.alignItems = "flex-start";
      textWrap.appendChild(title);
      textWrap.appendChild(idspan);

      // left: thumbnail + stacked text
      const left = document.createElement("div");
      left.style.display = "flex";
      left.style.alignItems = "center";
      left.appendChild(thumb);
      left.appendChild(textWrap);
      li.appendChild(left);

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = "8px";
      right.style.alignItems = "center";

      // lock checkbox
      const lock = document.createElement("input");
      lock.type = "checkbox";
      lock.title = "Lock layer";
      lock.checked = item._locked || false;
      lock.addEventListener("click", (ev) => {
        ev.stopPropagation();
        item._locked = lock.checked;
      });
      right.appendChild(lock);

      // opacity slider (small)
      const op = document.createElement("input");
      op.type = "range";
      op.min = 0;
      op.max = 100;
      op.value = item._opacity !== undefined ? item._opacity * 100 : 100;
      op.title = "Opacity";
      op.style.width = "80px";
      op.addEventListener("input", (ev) => {
        ev.stopPropagation();
        item._opacity = parseInt(op.value) / 100;
        redrawCanvas();
      });
      right.appendChild(op);

      // visibility checkbox (eye)
      const vis = document.createElement("input");
      vis.type = "checkbox";
      vis.checked = item.visible !== false;
      vis.title = item.visible === false ? "Show" : "Hide";
      vis.addEventListener("click", (ev) => {
        ev.stopPropagation();
        item.visible = vis.checked;
        // update title hint
        vis.title = item.visible === false ? "Show" : "Hide";
        redrawCanvas();
        updateInspector();
        if (this.layerListEl) this._renderLayerList();
      });
      right.appendChild(vis);

      li.appendChild(right);

      // highlight selected entries
      if (this.selected.includes(item)) {
        li.style.background = "#e6f0ff";
        li.style.borderLeft = "4px solid #0077ff";
      }

      li.addEventListener("click", (e) => {
        e.stopPropagation();
        const multi = e.shiftKey || e.ctrlKey || e.metaKey;
        if (!multi) this.clearSelection();
        this.select(item, multi);
        // ensure clicked layer is visible
        setTimeout(() => {
          li.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }, 0);
        redrawCanvas();
        updateInspector();
      });
      li.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/plain", i);
      });
      li.addEventListener("dragover", (ev) => {
        ev.preventDefault();
      });
      li.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const from = parseInt(ev.dataTransfer.getData("text/plain"));
        const to = parseInt(li.dataset.index);
        this._reorderScene(from, to);
      });
      this.layerListEl.appendChild(li);
    }
  }

  _reorderScene(fromIndex, toIndex) {
    // from and to are indexes into scene (0-based). We swap by moving element
    if (fromIndex === toIndex) return;
    const item = this.scene.splice(fromIndex, 1)[0];
    this.scene.splice(toIndex, 0, item);
    this.pushHistory();
    window.updateLayerList();
    redrawCanvas();
    updateInspector();
  }

  // Transform handle helpers
  _hitTestHandles(target, lx, ly) {
    // lx,ly are local coords (mx - target.x, my - target.y)
    // inverse transform for rotation/scale so handles line up
    let ilx = lx;
    let ily = ly;
    if (target.scale && target.scale !== 1) {
      ilx /= target.scale;
      ily /= target.scale;
    }
    if (target.rotation) {
      const ca = Math.cos(-target.rotation);
      const sa = Math.sin(-target.rotation);
      const nx = ilx * ca - ily * sa;
      const ny = ilx * sa + ily * ca;
      ilx = nx;
      ily = ny;
    }
    const b =
      target.type === "group"
        ? this._groupBounds(target)
        : target._computeBounds();
    if (!b) return null;
    const rotateHandle = { x: b.x + b.w / 2, y: b.y - 24 };
    const drot = Math.hypot(ilx - rotateHandle.x, ily - rotateHandle.y);
    if (drot < 12)
      return { type: "rotate", cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
    const corners = [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x + b.w, b.y + b.h],
      [b.x, b.y + b.h],
    ];
    for (let i = 0; i < corners.length; i++) {
      const c = corners[i];
      const d = Math.hypot(ilx - c[0], ily - c[1]);
      if (d < 10)
        return {
          type: "scale",
          corner: i,
          cx: b.x + b.w / 2,
          cy: b.y + b.h / 2,
        };
    }
    // special-case: if shape is a single-ellipse command, present width/height handles
    if (
      target.commands &&
      target.commands.length === 1 &&
      target.commands[0].type === "ellipse"
    ) {
      const ec = target.commands[0];
      // ellipse is centered at ec.x,ec.y local; extents are hw,hh
      const hw = (ec.w || 0) / 2;
      const hh = (ec.h || 0) / 2;
      const handles = [
        { x: ec.x - hw, y: ec.y },
        { x: ec.x + hw, y: ec.y },
        { x: ec.x, y: ec.y - hh },
        { x: ec.x, y: ec.y + hh },
      ];
      for (let i = 0; i < handles.length; i++) {
        const h = handles[i];
        const d = Math.hypot(ilx - h.x, ily - h.y);
        if (d < 8)
          return { type: "ellipse-scale", handle: i, cx: ec.x, cy: ec.y };
      }
    }
    return null;
  }

  _startTransform(target, kind, info, startMx, startMy) {
    this.transformDrag = {
      target,
      kind,
      info,
      startMx,
      startMy,
      startRotation: target.rotation,
      startScale: target.scale,
    };
    this.movedDuringInteraction = false;
  }

  _applyTransform(mx, my) {
    if (!this.transformDrag) return;
    const td = this.transformDrag;
    const t = td.target;
    const cx = td.info.cx + (t.x || 0);
    const cy = td.info.cy + (t.y || 0);
    if (td.kind === "rotate") {
      const a0 = Math.atan2(td.startMy - cy, td.startMx - cx);
      const a1 = Math.atan2(my - cy, mx - cx);
      const delta = a1 - a0;
      t.rotation = td.startRotation + delta;
    } else if (td.kind === "scale") {
      const dist0 = Math.hypot(td.startMx - cx, td.startMy - cy);
      const dist1 = Math.hypot(mx - cx, my - cy);
      const factor = dist0 ? dist1 / dist0 : 1;
      t.scale = td.startScale * factor;
    } else if (td.kind === "ellipse-scale") {
      // handle index 0/1 map to width handles (left/right), 2/3 to height (top/bottom)
      const info = td.info;
      // convert mouse to local coords relative to shape
      let lx = mx - t.x;
      let ly = my - t.y;
      if (t.scale && t.scale !== 1) {
        lx /= t.scale;
        ly /= t.scale;
      }
      if (t.rotation) {
        const ca = Math.cos(-t.rotation);
        const sa = Math.sin(-t.rotation);
        const nx = lx * ca - ly * sa;
        const ny = lx * sa + ly * ca;
        lx = nx;
        ly = ny;
      }
      const ec = t.commands[0];
      const localHandle = info.handle;
      if (localHandle === 0 || localHandle === 1) {
        // width handle: compute new half-width from ec.x to lx
        const newHw = Math.abs(lx - ec.x);
        ec.w = Math.max(2, newHw * 2);
      } else {
        // height handle
        const newHh = Math.abs(ly - ec.y);
        ec.h = Math.max(2, newHh * 2);
      }
    }
    this.movedDuringInteraction = true;
  }

  _finishTransform() {
    // auto-apply scale/rotate if the user has enabled the options
    try {
      const autoScaleEl = document.getElementById("auto-apply-scale");
      const autoRotateEl = document.getElementById("auto-apply-rotate");
      const didMove = this.movedDuringInteraction;
      if (didMove && autoScaleEl && autoScaleEl.checked) {
        // apply scale before finalizing
        this.applyScaleToSelection();
      }
      if (didMove && autoRotateEl && autoRotateEl.checked) {
        this.applyRotateToSelection();
      }
    } catch (e) {}
    if (this.movedDuringInteraction) this.pushHistory();
    this.transformDrag = null;
    this.movedDuringInteraction = false;
  }

  // Bake current scale into shape geometry (vertices/commands) and reset scale to 1
  applyScaleToSelection() {
    if (!this.selected || !this.selected.length) return;
    this.selected.forEach((s) => {
      if (!s || !s.scale || s.scale === 1) return;
      const sc = s.scale;
      // apply to vertices
      if (s.vertices && Array.isArray(s.vertices)) {
        s.vertices.forEach((v) => {
          v.x = v.x * sc;
          v.y = v.y * sc;
        });
      }
      // apply to commands where numeric params exist (ellipse/rect/vertex/line/arc/bezier)
      if (s.commands && Array.isArray(s.commands)) {
        s.commands.forEach((c) => {
          // special-case text: scale its font size rather than trying to scale x/y coordinates
          if (c.type === "text") {
            if (typeof c.size === "number") c.size = Math.max(1, c.size * sc);
            // note: keep x/y unchanged (they are local anchor points)
            return;
          }
          // for image commands, scale width/height and clamp later when image loaded
          if (c.type === "image") {
            if (typeof c.w === "number") c.w = c.w * sc;
            if (typeof c.h === "number") c.h = c.h * sc;
            return;
          }
          [
            "x",
            "y",
            "x1",
            "y1",
            "x2",
            "y2",
            "x3",
            "y3",
            "x4",
            "y4",
            "w",
            "h",
          ].forEach((k) => {
            if (c[k] !== undefined && typeof c[k] === "number")
              c[k] = c[k] * sc;
          });
        });
      }
      // apply to group children positions as well
      if (s.type === "group" && s.children && s.children.length) {
        s.children.forEach((ch) => {
          if (ch.x !== undefined) ch.x = ch.x * sc;
          if (ch.y !== undefined) ch.y = ch.y * sc;
          if (ch.scale !== undefined) ch.scale = ch.scale * sc;
        });
      }
      // clamp image sizes if present so they don't exceed canvas
      if (s.commands && Array.isArray(s.commands)) {
        try {
          const maxW = this.p ? this.p.width : 800;
          const maxH = this.p ? this.p.height : 800;
          s.commands.forEach((c) => {
            if (c.type === "image") {
              if (typeof c.w === "number") c.w = Math.min(c.w, maxW);
              if (typeof c.h === "number") c.h = Math.min(c.h, maxH);
            }
          });
        } catch (e) {}
      }
      s.scale = 1;
    });
    this.pushHistory();
    window.redrawCanvas();
    window.updateLayerList && window.updateLayerList();
  }

  // Bake current rotation into shape geometry (rotate vertices/commands around shape origin) and reset rotation to 0
  applyRotateToSelection() {
    if (!this.selected || !this.selected.length) return;
    this.selected.forEach((s) => {
      if (!s || !s.rotation || s.rotation === 0) return;
      const a = s.rotation;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rotPoint = (x, y) => {
        const rx = x * ca - y * sa;
        const ry = x * sa + y * ca;
        return { x: rx, y: ry };
      };
      // rotate vertices
      if (s.vertices && Array.isArray(s.vertices)) {
        s.vertices.forEach((v) => {
          const p = rotPoint(v.x, v.y);
          v.x = p.x;
          v.y = p.y;
        });
      }
      // rotate command numeric params (positions are relative to shape origin)
      if (s.commands && Array.isArray(s.commands)) {
        s.commands.forEach((c) => {
          // rotate points where appropriate
          if (c.x !== undefined && c.y !== undefined) {
            const p = rotPoint(c.x, c.y);
            c.x = p.x;
            c.y = p.y;
          }
          if (c.x1 !== undefined && c.y1 !== undefined) {
            const p = rotPoint(c.x1, c.y1);
            c.x1 = p.x;
            c.y1 = p.y;
          }
          if (c.x2 !== undefined && c.y2 !== undefined) {
            const p = rotPoint(c.x2, c.y2);
            c.x2 = p.x;
            c.y2 = p.y;
          }
          if (c.x3 !== undefined && c.y3 !== undefined) {
            const p = rotPoint(c.x3, c.y3);
            c.x3 = p.x;
            c.y3 = p.y;
          }
          if (c.x4 !== undefined && c.y4 !== undefined) {
            const p = rotPoint(c.x4, c.y4);
            c.x4 = p.x;
            c.y4 = p.y;
          }
        });
      }
      // rotate group children positions and rotate their own rotation
      if (s.type === "group" && s.children && s.children.length) {
        s.children.forEach((ch) => {
          if (ch.x !== undefined && ch.y !== undefined) {
            const p = rotPoint(ch.x, ch.y);
            ch.x = p.x;
            ch.y = p.y;
          }
          if (ch.rotation !== undefined) ch.rotation = (ch.rotation || 0) + a;
        });
      }
      s.rotation = 0;
    });
    this.pushHistory();
    window.redrawCanvas();
    window.updateLayerList && window.updateLayerList();
  }

  // Best-effort sketch.js parser for common primitives
  parseSketchSource(src) {
    const shapes = [];
    // tailored parser for the sketch.js structure provided: looks for zOrder array and switch-case blocks
    // extract zOrder array
    const zoMatch = src.match(/const\s+zOrder\s*=\s*\[([\s\S]*?)\]/);
    let order = null;
    if (zoMatch) {
      const items = zoMatch[1]
        .split(",")
        .map((s) => s.replace(/["'\s]/g, "").trim())
        .filter(Boolean);
      order = items;
    }

    // find the big switch over layer names - grab everything inside the forEach switch
    const switchMatch = src.match(
      /zOrder\.forEach\([\s\S]*?switch\s*\(layer\)\s*\{([\s\S]*?)\}\s*\)\s*;/
    );
    if (!switchMatch) {
      // fallback: parse simple primitives
      return this._fallbackParse(src);
    }

    const switchBody = switchMatch[1];
    // split cases: case "name": ... break;
    const caseRe = /case\s+\"([^\"]+)\"\s*:\s*([\s\S]*?)break\s*;/g;
    const cases = {};
    let cm;
    while ((cm = caseRe.exec(switchBody)) !== null) {
      const name = cm[1];
      const body = cm[2];
      cases[name] = body;
    }

    const toShapes = (body) => {
      // helper: if a parsed style has stroke but no fill, set an explicit transparent fill
      const styleNormalize = (obj) => {
        if ((obj.fill === null || obj.fill === undefined) && obj.stroke) {
          // set fully transparent fill so p5 will treat it as a numeric rgba with alpha 0
          obj.fill = "rgba(0,0,0,0)";
        }
        // if stroke explicitly null (noStroke), ensure strokeWeight is zero so importer doesn't draw a stroke
        if (obj.stroke === null) obj.strokeWeight = 0;
        return obj;
      };
      // sequentially parse statements so style changes apply to subsequent primitives
      let fillVal = null;
      let strokeVal = null;
      let swVal = 1;
      // remove comments for simpler tokenization
      const clean = body
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      // token patterns
      const stmtRe =
        /(fill|stroke|noFill|noStroke|strokeWeight|beginShape|endShape|vertex|ellipse|rect|line|arc)\s*\(([^)]*)\)|beginShape\s*\(|endShape\s*\(|vertex\s*\(\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*\)/g;
      // fallback: we'll just scan for known constructs in order using a simpler loop
      let idx = 0;
      while (idx < clean.length) {
        // try to match fill/stroke/noFill/noStroke/strokeWeight
        const rest = clean.slice(idx);
        const fnMatch = rest.match(
          /^\s*(fill|stroke|noFill|noStroke|strokeWeight)\s*(?:\(([^)]*)\))?/
        );
        if (fnMatch) {
          const fn = fnMatch[1];
          const arg = fnMatch[2];
          if (fn === "noFill") fillVal = null;
          else if (fn === "noStroke") strokeVal = null;
          else if (fn === "fill" && arg)
            fillVal = this._evalColorExpr(arg, src);
          else if (fn === "stroke" && arg)
            strokeVal = this._evalColorExpr(arg, src);
          else if (fn === "strokeWeight" && arg) swVal = parseFloat(arg);
          idx += fnMatch[0].length;
          continue;
        }

        // beginShape blocks: capture until endShape(...);
        const bMatch = rest.match(
          /beginShape\s*\([\s\S]*?\);?|beginShape\s*\([\s\S]*?$/
        );
        if (bMatch && rest.indexOf("beginShape") === 0) {
          // find matching endShape
          const endIdx = rest.search(/endShape\s*\([^\)]*\)\s*;/);
          let block = null;
          if (endIdx >= 0) {
            block = rest.slice(
              0,
              endIdx + rest.match(/endShape\s*\([^\)]*\)\s*;/)[0].length
            );
            idx += block.length;
          } else {
            block = rest;
            idx = clean.length;
          }
          const vre = /vertex\s*\(\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*\)/g;
          let vm;
          const vlist = [];
          while ((vm = vre.exec(block)) !== null)
            vlist.push({ x: parseFloat(vm[1]), y: parseFloat(vm[2]) });
          if (vlist.length) {
            shapes.push(
              new Shape(
                styleNormalize({
                  x: 0,
                  y: 0,
                  vertices: vlist,
                  fill: fillVal,
                  stroke: strokeVal,
                  strokeWeight: swVal,
                })
              )
            );
          }
          continue;
        }

        // ellipse
        const ell = rest.match(
          /^\s*ellipse\s*\(\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*\)\s*;?/
        );
        if (ell) {
          shapes.push(
            new Shape(
              styleNormalize({
                x: 0,
                y: 0,
                commands: [
                  {
                    type: "ellipse",
                    x: parseFloat(ell[1]),
                    y: parseFloat(ell[2]),
                    w: parseFloat(ell[3]),
                    h: parseFloat(ell[4]),
                  },
                ],
                fill: fillVal,
                stroke: strokeVal,
                strokeWeight: swVal,
              })
            )
          );
          idx += ell[0].length;
          continue;
        }

        // rect
        const rectm = rest.match(
          /^\s*rect\s*\(\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*\)\s*;?/
        );
        if (rectm) {
          shapes.push(
            new Shape(
              styleNormalize({
                x: 0,
                y: 0,
                commands: [
                  {
                    type: "rect",
                    x: parseFloat(rectm[1]),
                    y: parseFloat(rectm[2]),
                    w: parseFloat(rectm[3]),
                    h: parseFloat(rectm[4]),
                    mode: "corner",
                  },
                ],
                fill: fillVal,
                stroke: strokeVal,
                strokeWeight: swVal,
              })
            )
          );
          idx += rectm[0].length;
          continue;
        }

        // line
        const linem = rest.match(
          /^\s*line\s*\(\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*\)\s*;?/
        );
        if (linem) {
          shapes.push(
            new Shape(
              styleNormalize({
                commands: [
                  {
                    type: "line",
                    x1: parseFloat(linem[1]),
                    y1: parseFloat(linem[2]),
                    x2: parseFloat(linem[3]),
                    y2: parseFloat(linem[4]),
                  },
                ],
                stroke: strokeVal,
                strokeWeight: swVal,
              })
            )
          );
          idx += linem[0].length;
          continue;
        }

        // arc
        const arcm = rest.match(
          /^\s*arc\s*\(\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*,\s*([\-0-9\.]+)\s*,\s*([^,]+)\s*,\s*([^\)]+)\)\s*;?/
        );
        if (arcm) {
          // try to interpret start/end tokens (PI, TWO_PI, numeric literals)
          const interpretAngle = (tok) => {
            if (!tok) return 0;
            const t = tok.trim();
            if (t === "PI") return Math.PI;
            if (t === "TWO_PI" || t === "TWO-PI") return Math.PI * 2;
            if (t === "HALF_PI") return Math.PI / 2;
            if (t === "QUARTER_PI") return Math.PI / 4;
            const v = parseFloat(t);
            return isNaN(v) ? 0 : v;
          };
          shapes.push(
            new Shape(
              styleNormalize({
                commands: [
                  {
                    type: "arc",
                    x: parseFloat(arcm[1]),
                    y: parseFloat(arcm[2]),
                    w: parseFloat(arcm[3]),
                    h: parseFloat(arcm[4]),
                    start: interpretAngle(arcm[5]),
                    end: interpretAngle(arcm[6]),
                  },
                ],
                fill: fillVal,
                stroke: strokeVal,
                strokeWeight: swVal,
              })
            )
          );
          idx += arcm[0].length;
          continue;
        }

        // advance a little when nothing matched to avoid infinite loop
        idx += 1;
      }
    };

    // if we have an order, iterate that first to preserve z-order
    if (order && Object.keys(cases).length) {
      order.forEach((name) => {
        const body = cases[name];
        if (body) toShapes(body);
      });
    } else {
      Object.values(cases).forEach((b) => toShapes(b));
    }
    return shapes;
  }

  redo() {
    if (!this.future.length) return;
    const f = this.future.pop();
    try {
      this.history.push(JSON.stringify(this.toJSON()));
      this.loadJSON(JSON.parse(f));
      if (this.layerListEl) window.updateLayerList();
      try {
        if (typeof window.updateHistoryPanel === "function")
          window.updateHistoryPanel();
      } catch (e) {}
    } catch (e) {}
  }

  // Jump to a specific history index (0 = oldest). Loads that snapshot and trims history to that point.
  jumpToHistory(index) {
    if (!this.history || this.history.length === 0) return;
    if (index < 0 || index >= this.history.length) return;
    try {
      const snap = JSON.parse(this.history[index]);
      // trim history to selected index (keep snapshots up to index)
      this.history = this.history.slice(0, index + 1);
      this.future = [];
      this.loadJSON(snap);
      if (this.layerListEl) window.updateLayerList();
      try {
        if (typeof window.updateHistoryPanel === "function")
          window.updateHistoryPanel();
      } catch (e) {}
    } catch (e) {}
  }

  toJSON() {
    return this.scene.map((s) => s.toJSON());
  }

  loadJSON(json) {
    this.scene = [];
    json.forEach((obj) => {
      if (obj.type === "group") this.scene.push(new Group(obj));
      else this.scene.push(new Shape(obj));
    });
    this.clearSelection();
    // preload images
    this.scene.forEach((s) => {
      if (s.commands)
        s.commands.forEach((c) => {
          if (c.type === "image" && c.src) this._loadImageForCommand(c);
        });
    });
    if (this.layerListEl) window.updateLayerList();
  }

  draw() {
    // draw all shapes
    const p = this.p;
    this.scene.forEach((s) => s.draw(p));

    // draw selection markers (always show overlay even in vertex mode)
    if (this.selected && this.selected.length) {
      this.selected.forEach((s) => {
        p.push();
        p.translate(s.x, s.y);
        // draw a semi-transparent blue bounding box for clarity
        const b =
          s.type === "group" ? this._groupBounds(s) : s._computeBounds();
        if (b) {
          // draw bounding box transformed to match shape rotation/scale
          p.push();
          if (s.rotation) p.rotate(s.rotation);
          if (s.scale && s.scale !== 1) p.scale(s.scale);
          p.noStroke();
          p.fill(0, 119, 255, 40);
          p.rectMode(p.CORNER);
          p.rect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
          p.pop();
        }
        // stronger center marker
        p.noStroke();
        p.fill("#0077ff");
        p.ellipse(0, 0, 12, 12);
        p.pop();
      });
    }
    // draw vertices only when in vertex mode for selected shapes
    if (this.mode === "vertex") {
      this.selected.forEach((s) => {
        if (s.vertices && s.vertices.length) {
          p.push();
          p.translate(s.x, s.y);
          if (s.rotation) p.rotate(s.rotation);
          if (s.scale && s.scale !== 1) p.scale(s.scale);
          s.vertices.forEach((v, i) => {
            // isolate drawing state per-vertex so fill/stroke changes don't leak
            p.push();
            // base vertex (filled)
            p.fill("#fff");
            p.stroke("#333");
            p.strokeWeight(1);
            p.ellipse(v.x, v.y, 8, 8);

            // highlight selected vertex with blue border (drawn on top)
            if (
              this._selectedVertex &&
              this._selectedVertex.shape === s &&
              this._selectedVertex.index === i
            ) {
              p.noFill();
              p.stroke("#0077ff");
              p.strokeWeight(2);
              p.ellipse(v.x, v.y, 12, 12);
            }
            // highlight hovered vertex with lighter blue (drawn on top)
            if (
              this._hoverVertex &&
              this._hoverVertex.shape === s &&
              this._hoverVertex.index === i
            ) {
              p.noFill();
              p.stroke("rgba(0,120,255,0.7)");
              p.strokeWeight(1.5);
              p.ellipse(v.x, v.y, 10, 10);
            }

            p.pop();
          });
          p.pop();
        } else if (s.commands && s.commands.length) {
          // support vertex-like editing for line/bezier commands
          p.push();
          p.translate(s.x, s.y);
          if (s.rotation) p.rotate(s.rotation);
          if (s.scale && s.scale !== 1) p.scale(s.scale);

          s.commands.forEach((c, cmdIndex) => {
            if (!c) return;
            const points = [];
            if (c.type === "line") {
              points.push({ x: c.x1, y: c.y1, xProp: "x1", yProp: "y1" });
              points.push({ x: c.x2, y: c.y2, xProp: "x2", yProp: "y2" });
            } else if (c.type === "bezier") {
              // handle lines
              p.push();
              p.noFill();
              p.stroke("rgba(0,120,255,0.45)");
              p.strokeWeight(1);
              p.line(c.x1, c.y1, c.x2, c.y2);
              p.line(c.x3, c.y3, c.x4, c.y4);
              p.pop();

              points.push({ x: c.x1, y: c.y1, xProp: "x1", yProp: "y1" });
              points.push({ x: c.x2, y: c.y2, xProp: "x2", yProp: "y2" });
              points.push({ x: c.x3, y: c.y3, xProp: "x3", yProp: "y3" });
              points.push({ x: c.x4, y: c.y4, xProp: "x4", yProp: "y4" });
            } else {
              return;
            }

            points.forEach((pt) => {
              p.push();
              p.fill("#fff");
              p.stroke("#333");
              p.strokeWeight(1);
              p.ellipse(pt.x, pt.y, 8, 8);

              if (
                this._selectedCmdPoint &&
                this._selectedCmdPoint.shape === s &&
                this._selectedCmdPoint.cmdIndex === cmdIndex &&
                this._selectedCmdPoint.xProp === pt.xProp &&
                this._selectedCmdPoint.yProp === pt.yProp
              ) {
                p.noFill();
                p.stroke("#0077ff");
                p.strokeWeight(2);
                p.ellipse(pt.x, pt.y, 12, 12);
              }
              p.pop();
            });
          });

          p.pop();
        }
      });
    }
    // draw transform handles for single selected item (keep circle tools only)
    // hide transform handles in vertex mode
    if (this.selected.length === 1 && this.mode !== "vertex") {
      const s = this.selected[0];
      p.push();
      p.translate(s.x, s.y);
      // apply rotation/scale so handles match the shape
      if (s.rotation) p.rotate(s.rotation);
      if (s.scale && s.scale !== 1) p.scale(s.scale);
      const b = s.type === "group" ? this._groupBounds(s) : s._computeBounds();
      if (b) {
        const hx = b.x + b.w / 2;
        const hy = b.y - 24;
        p.fill("#fff");
        p.stroke("#0077ff");
        p.ellipse(hx, hy, 12, 12); // rotate
        const corners = [
          [b.x, b.y],
          [b.x + b.w, b.y],
          [b.x + b.w, b.y + b.h],
          [b.x, b.y + b.h],
        ];
        corners.forEach((c) => {
          p.ellipse(c[0], c[1], 10, 10);
        });
      }
      p.pop();
    }
    // draw ellipse resize handles (visible if selected single ellipse)
    if (this.selected.length === 1) {
      const s = this.selected[0];
      if (
        s.commands &&
        s.commands.length === 1 &&
        s.commands[0].type === "ellipse"
      ) {
        const ec = s.commands[0];
        p.push();
        p.translate(s.x, s.y);
        if (s.rotation) p.rotate(s.rotation);
        if (s.scale && s.scale !== 1) p.scale(s.scale);
        p.fill("#fff");
        p.stroke("#0077ff");
        p.strokeWeight(1.5);
        const hw = (ec.w || 0) / 2;
        const hh = (ec.h || 0) / 2;
        const handles = [
          [ec.x - hw, ec.y],
          [ec.x + hw, ec.y],
          [ec.x, ec.y - hh],
          [ec.x, ec.y + hh],
        ];
        for (let h of handles) {
          p.ellipse(h[0], h[1], 10, 10);
        }
        p.pop();
      }
    }
    // draw alignment guides if present
    if (this._alignmentGuides && this._alignmentGuides.length) {
      this._drawAlignmentGuides(p);
    }
  }

  // compute simple alignment guides (vertical/horizontal center and edges) between moving shapes and other scene items
  _computeAlignmentGuides(movingItems) {
    // movingItems: array of shapes that are being moved (world-space bounds)
    const guides = [];
    const toleranceEl = document.getElementById("snap-tolerance");
    const tol = (toleranceEl && parseInt(toleranceEl.value)) || 6;
    // collect candidate anchors from non-moving shapes: centers and edges
    const anchors = [];
    for (const s of this.scene) {
      if (movingItems.includes(s)) continue;
      const b = s.type === "group" ? this._groupBounds(s) : s._computeBounds();
      if (!b) continue;
      const bx = (s.x || 0) + b.x;
      const by = (s.y || 0) + b.y;
      anchors.push({ x: bx + b.w / 2, y: by + b.h / 2, type: "center" });
      anchors.push({ x: bx, y: by + b.h / 2, type: "left" });
      anchors.push({ x: bx + b.w, y: by + b.h / 2, type: "right" });
      anchors.push({ x: bx + b.w / 2, y: by, type: "top" });
      anchors.push({ x: bx + b.w / 2, y: by + b.h, type: "bottom" });
    }
    // for each moving item, compare its anchors
    for (const m of movingItems) {
      const mb = m.type === "group" ? this._groupBounds(m) : m._computeBounds();
      if (!mb) continue;
      const mx = (m.x || 0) + mb.x;
      const my = (m.y || 0) + mb.y;
      const manchors = [
        { x: mx + mb.w / 2, y: my + mb.h / 2, which: "center" },
        { x: mx, y: my + mb.h / 2, which: "left" },
        { x: mx + mb.w, y: my + mb.h / 2, which: "right" },
        { x: mx + mb.w / 2, y: my, which: "top" },
        { x: mx + mb.w / 2, y: my + mb.h, which: "bottom" },
      ];
      for (const ma of manchors) {
        for (const a of anchors) {
          // vertical alignment (x close)
          if (Math.abs(ma.x - a.x) <= tol) {
            guides.push({
              x1: a.x,
              y1: 0,
              x2: a.x,
              y2: this.p.height,
              type: "v",
              match: a,
              moving: ma,
            });
          }
          // horizontal alignment (y close)
          if (Math.abs(ma.y - a.y) <= tol) {
            guides.push({
              x1: 0,
              y1: a.y,
              x2: this.p.width,
              y2: a.y,
              type: "h",
              match: a,
              moving: ma,
            });
          }
        }
      }
    }
    this._alignmentGuides = guides;
  }

  _drawAlignmentGuides(p) {
    p.push();
    p.translate(-p.width / 2, -p.height / 2);
    p.stroke(0, 160, 255);
    p.strokeWeight(1);
    p.fill(0, 160, 255, 20);
    try {
      const ctx = p.drawingContext;
      ctx.setLineDash([4, 4]);
    } catch (e) {}
    for (const g of this._alignmentGuides) {
      if (g.type === "v") p.line(g.x1, g.y1, g.x2, g.y2);
      else p.line(g.x1, g.y1, g.x2, g.y2);
    }
    try {
      const ctx = p.drawingContext;
      ctx.setLineDash([]);
    } catch (e) {}
    p.pop();
  }

  // unified snap-on-drop helper: snaps selected shapes or vertex edits to grid/guides when appropriate
  _applySnapOnDrop(kind) {
    // kind: 'drag'|'vertex'|'transform' etc. perform snapping based on UI toggles
    try {
      const snapEl = document.getElementById("snap-to-grid");
      const gridEl = document.getElementById("grid-size");
      const snapWhile = document.getElementById("snap-while-dragging");
      const snapToGuidesEl = document.getElementById("snap-to-guides");
      const showGuides = document.getElementById("show-guides");
      const tolEl = document.getElementById("snap-tolerance");
      const tol = (tolEl && parseInt(tolEl.value)) || 6;
      // grid snap on drop
      if (snapEl && snapEl.checked && gridEl) {
        const gs = parseInt(gridEl.value) || 10;
        this.selected.forEach((s) => {
          if (s.x !== undefined) s.x = Math.round(s.x / gs) * gs;
          if (s.y !== undefined) s.y = Math.round(s.y / gs) * gs;
        });
      }
      // guides snapping: find closest guide within tolerance and snap selected items
      if (
        (snapToGuidesEl && snapToGuidesEl.checked) ||
        (showGuides && showGuides.checked)
      ) {
        // compute guides for current selection against scene
        this._computeAlignmentGuides(this.selected.slice());
        if (this._alignmentGuides && this._alignmentGuides.length) {
          for (const s of this.selected) {
            const b =
              s.type === "group" ? this._groupBounds(s) : s._computeBounds();
            if (!b) continue;
            const sx = (s.x || 0) + b.x;
            const sy = (s.y || 0) + b.y;
            for (const g of this._alignmentGuides) {
              if (g.type === "v") {
                // snap s.x so its anchor aligns to g.x1
                const target = g.x1;
                // choose whether snapping to left/center/right depending on closeness
                const centerX = sx + b.w / 2;
                const leftX = sx;
                const rightX = sx + b.w;
                if (Math.abs(centerX - target) <= tol) {
                  s.x += target - centerX;
                } else if (Math.abs(leftX - target) <= tol) {
                  s.x += target - leftX;
                } else if (Math.abs(rightX - target) <= tol) {
                  s.x += target - rightX;
                }
              } else if (g.type === "h") {
                const target = g.y1;
                const centerY = sy + b.h / 2;
                const topY = sy;
                const bottomY = sy + b.h;
                if (Math.abs(centerY - target) <= tol) {
                  s.y += target - centerY;
                } else if (Math.abs(topY - target) <= tol) {
                  s.y += target - topY;
                } else if (Math.abs(bottomY - target) <= tol) {
                  s.y += target - bottomY;
                }
              }
            }
          }
        }
      }
    } catch (e) {}
    // redraw after snapping
    window.redrawCanvas();
    window.updateLayerList && window.updateLayerList();
  }

  _groupBounds(g) {
    let bounds = null;
    g.children.forEach((ch) => {
      const b = ch._computeBounds();
      if (!b) return;
      const bx = b.x + (ch.x || 0);
      const by = b.y + (ch.y || 0);
      if (!bounds) bounds = { x: bx, y: by, w: b.w, h: b.h };
      else {
        const minx = Math.min(bounds.x, bx);
        const miny = Math.min(bounds.y, by);
        const maxx = Math.max(bounds.x + bounds.w, bx + b.w);
        const maxy = Math.max(bounds.y + bounds.h, by + b.h);
        bounds.x = minx;
        bounds.y = miny;
        bounds.w = maxx - minx;
        bounds.h = maxy - miny;
      }
    });
    return bounds;
  }

  _loadImageForCommand(c) {
    if (!c.src) return;
    if (this.imagesCache[c.src]) {
      c.imgInstance = this.imagesCache[c.src];
      return;
    }
    const img = new Image();
    img.onload = () => {
      // clamp image dimensions to canvas size to avoid oversized images
      try {
        const cvsW = this.p ? this.p.width : 800;
        const cvsH = this.p ? this.p.height : 800;
        // if command provided explicit w/h, prefer those but clamp
        if (c.w && c.h) {
          c.w = Math.min(c.w, cvsW);
          c.h = Math.min(c.h, cvsH);
        } else {
          // otherwise use natural image size but clamp to canvas
          c.w = Math.min(img.width || cvsW, cvsW);
          c.h = Math.min(img.height || cvsH, cvsH);
        }
      } catch (e) {}
      this.imagesCache[c.src] = img;
      c.imgInstance = img;
      window.redrawCanvas();
    };
    img.src = c.src;
  }

  exportP5Source() {
    const lines = [];
    lines.push("function setup() {");
    lines.push("  createCanvas(800, 800);");
    lines.push("  noLoop();");
    lines.push("}");
    lines.push("");
    lines.push("function draw() {");
    lines.push("  background(245, 240, 250);");
    lines.push("  translate(width/2, height/2);");
    this.scene.forEach((s) => {
      // wrap each top-level item with push/transform so placement is preserved
      lines.push("  push();");
      lines.push(`  translate(${s.x || 0}, ${s.y || 0});`);
      if (s.rotation) lines.push(`  rotate(${s.rotation});`);
      if (s.scale && s.scale !== 1) lines.push(`  scale(${s.scale});`);
      if (s.type === "group") {
        lines.push("  // group " + s.id);
        s.children.forEach((c) => {
          // children have coordinates relative to group; wrap each child so their local transforms apply
          lines.push("  push();");
          lines.push(`  translate(${c.x || 0}, ${c.y || 0});`);
          if (c.rotation) lines.push(`  rotate(${c.rotation});`);
          if (c.scale && c.scale !== 1) lines.push(`  scale(${c.scale});`);
          const cd = c.toJSON();
          // child already positioned via translate above, zero offsets to avoid doubling
          cd.x = 0;
          cd.y = 0;
          const code = this._shapeToP5(cd);
          code.split("\n").forEach((ln) => lines.push("  " + ln));
          lines.push("  pop();");
        });
      } else {
        const jd = s.toJSON();
        // we've already translated by s.x/s.y
        jd.x = 0;
        jd.y = 0;
        const code = this._shapeToP5(jd);
        code.split("\n").forEach((ln) => lines.push("  " + ln));
      }
      lines.push("  pop();");
    });
    lines.push("}");
    return lines.join("\n");
  }

  _shapeToP5(obj) {
    if (!obj) return "";
    const parts = [];
    // helper to format color values for p5: returns e.g. 'fill(255,0,0)' or 'fill(255,0,0,128)'
    const fmtColor = (c) => {
      if (!c) return null;
      if (Array.isArray(c)) {
        if (c.length === 3) return c.join(",");
        if (c.length >= 4) return `${c[0]},${c[1]},${c[2]},${c[3]}`;
      }
      if (typeof c === "string") {
        // hex #rrggbb or #rrggbbaa
        if (c[0] === "#") {
          if (c.length === 7) {
            const r = parseInt(c.slice(1, 3), 16);
            const g = parseInt(c.slice(3, 5), 16);
            const b = parseInt(c.slice(5, 7), 16);
            return `${r},${g},${b}`;
          }
          if (c.length === 9) {
            const r = parseInt(c.slice(1, 3), 16);
            const g = parseInt(c.slice(3, 5), 16);
            const b = parseInt(c.slice(5, 7), 16);
            const a = parseInt(c.slice(7, 9), 16);
            return `${r},${g},${b},${a}`;
          }
        }
        // rgb(...) or rgba(...)
        const m = c.match(/rgba?\s*\(([^)]+)\)/i);
        if (m) {
          const parts = m[1]
            .split(",")
            .map((s) => parseFloat(s.trim()))
            .filter((n) => !isNaN(n));
          if (parts.length === 3) return `${parts[0]},${parts[1]},${parts[2]}`;
          if (parts.length >= 4) {
            let a = parts[3];
            // if alpha in 0..1 convert to 0..255
            if (a <= 1) a = Math.round(a * 255);
            return `${parts[0]},${parts[1]},${parts[2]},${a}`;
          }
        }
      }
      return null;
    };

    // fill / stroke / weight
    const fcol = fmtColor(obj.fill);
    if (fcol) parts.push(`fill(${fcol});`);
    else parts.push("noFill();");
    const scol = fmtColor(obj.stroke);
    if (scol) parts.push(`stroke(${scol});`);
    else parts.push("noStroke();");
    parts.push(
      `strokeWeight(${obj.strokeWeight !== undefined ? obj.strokeWeight : 1});`
    );

    // vertices (polygon)
    if (obj.vertices && obj.vertices.length) {
      parts.push("beginShape();");
      obj.vertices.forEach((v) =>
        parts.push(`vertex(${v.x + (obj.x || 0)}, ${v.y + (obj.y || 0)});`)
      );
      parts.push("endShape(CLOSE);");
    }

    // commands
    if (obj.commands && obj.commands.length) {
      obj.commands.forEach((c) => {
        switch (c.type) {
          case "ellipse":
            parts.push(
              `ellipse(${c.x + (obj.x || 0)}, ${c.y + (obj.y || 0)}, ${c.w}, ${
                c.h
              });`
            );
            break;
          case "rect":
            parts.push(
              `rect(${c.x + (obj.x || 0)}, ${c.y + (obj.y || 0)}, ${c.w}, ${
                c.h
              });`
            );
            break;
          case "line":
            parts.push(
              `line(${c.x1 + (obj.x || 0)}, ${c.y1 + (obj.y || 0)}, ${
                c.x2 + (obj.x || 0)
              }, ${c.y2 + (obj.y || 0)});`
            );
            break;
          case "arc":
            parts.push(
              `arc(${c.x + (obj.x || 0)}, ${c.y + (obj.y || 0)}, ${c.w}, ${
                c.h
              }, ${c.start}, ${c.end});`
            );
            break;
          case "bezier":
            parts.push(
              `bezier(${c.x1 + (obj.x || 0)}, ${c.y1 + (obj.y || 0)}, ${
                c.x2 + (obj.x || 0)
              }, ${c.y2 + (obj.y || 0)}, ${c.x3 + (obj.x || 0)}, ${
                c.y3 + (obj.y || 0)
              }, ${c.x4 + (obj.x || 0)}, ${c.y4 + (obj.y || 0)});`
            );
            break;
          case "text":
            parts.push(`textSize(${c.size || 24});`);
            parts.push(
              `text("${(c.content || "").replace(/\"/g, '\\"')}", ${
                c.x + (obj.x || 0)
              }, ${c.y + (obj.y || 0)});`
            );
            break;
          default:
            break;
        }
      });
    }
    return parts.join("\n");
  }

  _cssToRgbArray(css) {
    if (typeof css !== "string") return [0, 0, 0];
    if (css[0] === "#" && css.length === 7) {
      const r = parseInt(css.slice(1, 3), 16);
      const g = parseInt(css.slice(3, 5), 16);
      const b = parseInt(css.slice(5, 7), 16);
      return [r, g, b];
    }
    return [0, 0, 0];
  }
}

// color evaluator utility placed on Editor prototype
Editor.prototype._evalColorExpr = function (expr, srcContext) {
  if (!expr) return null;
  expr = expr.trim();
  // direct hex string like '#ffeecc' or '"#ffeecc"'
  const hexMatch = expr.match(/#[0-9a-fA-F]{6}/);
  if (hexMatch) return hexMatch[0];
  // rgb(...) or color(r,g,b)
  let m = expr.match(
    /rgb\s*\(\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*\)/i
  );
  if (m) return `rgb(${m[1]},${m[2]},${m[3]})`;
  m = expr.match(
    /color\s*\(\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*\)/i
  );
  if (m) return `rgb(${m[1]},${m[2]},${m[3]})`;
  // comma-separated numeric args like '255, 230, 220' or '180,160,180,60' or single '40'
  const numsOnly = expr.match(/^\s*([0-9\.]+\s*(?:,\s*[0-9\.]+\s*)*)$/);
  if (numsOnly) {
    const parts = expr
      .split(",")
      .map((s) => parseFloat(s.trim()))
      .filter((s) => !isNaN(s));
    if (parts.length === 1) {
      const v = parts[0];
      return `rgb(${v},${v},${v})`;
    }
    if (parts.length === 3) {
      return `rgb(${parts[0]},${parts[1]},${parts[2]})`;
    }
    if (parts.length >= 4) {
      // keep alpha in 0..255 (p5 numeric alpha expects 0..255)
      const a = parts[3];
      return `rgba(${parts[0]},${parts[1]},${parts[2]},${a})`;
    }
  }
  // array like [r,g,b]
  m = expr.match(/\[\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*\]/);
  if (m) return `rgb(${m[1]},${m[2]},${m[3]})`;
  // numeric tuple like (r,g,b)
  m = expr.match(/\(\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*\)/);
  if (m) return `rgb(${m[1]},${m[2]},${m[3]})`;
  // variable lookup: try to find a var/const/let declaration in srcContext with that name
  const nameMatch = expr.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)$/);
  if (nameMatch && srcContext) {
    const name = nameMatch[1];
    // find simple declarations like: const col = '#ffeecc'; or let col = color(..);
    const declRe = new RegExp(
      `(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+)`,
      "g"
    );
    let dm;
    while ((dm = declRe.exec(srcContext)) !== null) {
      const rhs = dm[1].trim();
      const v = this._evalColorExpr(rhs, null);
      if (v) return v;
    }
  }
  // as a last resort, return null (interpreted as noFill/noStroke)
  return null;
};

// make _cssToRgbArray accept rgb(...) strings too
Editor.prototype._cssToRgbArray = function (css) {
  if (!css) return [0, 0, 0];
  if (typeof css === "string") {
    const hex = css.match(/#([0-9a-fA-F]{6})/);
    if (hex) {
      const r = parseInt(hex[1].slice(0, 2), 16);
      const g = parseInt(hex[1].slice(2, 4), 16);
      const b = parseInt(hex[1].slice(4, 6), 16);
      return [r, g, b];
    }
    const rgbm = css.match(
      /rgb\s*\(\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*\)/i
    );
    if (rgbm)
      return [parseFloat(rgbm[1]), parseFloat(rgbm[2]), parseFloat(rgbm[3])];
  }
  if (Array.isArray(css)) return css.slice(0, 3);
  return [0, 0, 0];
};

// ---------------- p5 instance ----------------

const sketch = (p) => {
  let canvas;
  p.setup = () => {
    const holder = document.getElementById("canvas-holder");
    canvas = p.createCanvas(800, 800);
    canvas.parent(holder);
    p.background(255);
    editor = new Editor(p);

    wireUI();

    // add a sample shape
    const s = new Shape({
      x: 0,
      y: 0,
      fill: "#ffeedd",
      stroke: "#352f38",
      strokeWeight: 3,
      vertices: [
        { x: -100, y: -100 },
        { x: 100, y: -100 },
        { x: 100, y: 100 },
        { x: -100, y: 100 },
      ],
      name: "square",
    });
    editor.addShape(s);

    p.noLoop();
    redrawCanvas();
  };

  p.mousePressed = () => {
    // convert mouse to canvas-centered coords
    const mx = p.mouseX - p.width / 2;
    const my = p.mouseY - p.height / 2;
    if (
      p.mouseX < 0 ||
      p.mouseY < 0 ||
      p.mouseX > p.width ||
      p.mouseY > p.height
    )
      return;

    // draw tools
    if (editor.mode === "draw-line") {
      editor.drawTool.kind = "line";
      editor.drawTool.active = true;
      editor.drawTool.start = { x: mx, y: my };
      editor.drawTool.current = { x: mx, y: my };
      editor.drawTool.cursor = { x: mx, y: my };
      updateStatusBar();
      redrawCanvas();
      return;
    }

    if (editor.mode === "draw-bezier") {
      editor.drawTool.kind = "bezier";
      editor.drawTool.cursor = { x: mx, y: my };
      if (!Array.isArray(editor.drawTool.points)) editor.drawTool.points = [];
      editor.drawTool.points.push({ x: mx, y: my });

      // once we have 4 points, create a bezier shape
      if (editor.drawTool.points.length >= 4) {
        const pts = editor.drawTool.points.slice(0, 4);
        const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
        const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;

        const strokeHex =
          (document.getElementById("stroke-color") || {}).value || "#362f38";
        const strokeOpacity =
          (document.getElementById("stroke-opacity") || {}).value || 100;
        const noStroke = (document.getElementById("no-stroke") || {}).checked;
        const sw = parseFloat(
          (document.getElementById("stroke-weight") || {}).value
        );
        const strokeVal = noStroke ? null : hexToRgbA(strokeHex, strokeOpacity);

        const s = new Shape({
          x: cx,
          y: cy,
          fill: null,
          stroke: strokeVal,
          strokeWeight: isNaN(sw) ? 2 : sw,
          commands: [
            {
              type: "bezier",
              x1: pts[0].x - cx,
              y1: pts[0].y - cy,
              x2: pts[1].x - cx,
              y2: pts[1].y - cy,
              x3: pts[2].x - cx,
              y3: pts[2].y - cy,
              x4: pts[3].x - cx,
              y4: pts[3].y - cy,
            },
          ],
        });
        editor.addShape(s);
        editor.clearSelection();
        editor.select(s);
        editor.drawTool.points = [];
        editor.drawTool.cursor = null;
        updateInspector();
      }

      updateStatusBar();
      redrawCanvas();
      return;
    }

    if (editor.mode === "select") {
      // get all hits at point (top-first)
      const hits = editor.findAllAt(mx, my);
      let found = null;
      let foundHandle = null;

      // if pipette mode, sample color from topmost hit and apply to target, then exit pipette
      if (editor.pipetteMode) {
        if (hits.length) {
          const targetShape = hits[0];
          const sampled = targetShape.fill || targetShape.stroke || null;
          const ev = window.event || {};
          if (sampled) {
            const hex = colorToHex(sampled) || null;
            // prefer explicit selected color target
            const target =
              editor._selectedColorTarget ||
              editor._pipetteTarget ||
              (ev.shiftKey || ev.altKey ? "secondary" : "primary");
            if (target && target.startsWith("palette-")) {
              const idx = parseInt(target.split("-")[1]);
              if (!isNaN(idx)) {
                editor.palette[idx] = hex || editor.palette[idx];
                renderPalette();
                try {
                  localStorage.setItem(
                    "p5_palette",
                    JSON.stringify(editor.palette)
                  );
                } catch (e) {}
              }
            } else if (target === "secondary") {
              const sec = document.getElementById("secondary-color");
              if (sec && hex) sec.style.background = hex;
              const strokeInput = document.getElementById("stroke-color");
              if (strokeInput && hex) strokeInput.value = hex;
              editor.selected.forEach((s) => {
                s.stroke = hex
                  ? hexToRgbA(
                      hex,
                      document.getElementById("stroke-opacity").value || 100
                    )
                  : null;
              });
            } else if (target === "stroke") {
              // write to stroke swatch
              const strokeSw = document.getElementById("stroke-swatch");
              if (strokeSw && hex) strokeSw.style.background = hex;
              const strokeInput = document.getElementById("stroke-color");
              if (strokeInput && hex) strokeInput.value = hex;
              editor.selected.forEach((s) => {
                s.stroke = hex
                  ? hexToRgbA(
                      hex,
                      document.getElementById("stroke-opacity").value || 100
                    )
                  : null;
              });
            } else {
              // default: write to fill/primary
              const pri = document.getElementById("primary-color");
              const fillSw = document.getElementById("fill-swatch");
              if (fillSw && hex) fillSw.style.background = hex;
              if (pri && hex) pri.style.background = hex;
              const fillInput = document.getElementById("fill-color");
              if (fillInput && hex) fillInput.value = hex;
              editor.selected.forEach((s) => {
                s.fill = hex
                  ? hexToRgbA(
                      hex,
                      document.getElementById("fill-opacity").value || 100
                    )
                  : null;
              });
            }
            // after sampling, disable pipette so normal selection resumes
            editor.pipetteMode = false;
            const pipBtn = document.getElementById("pipette-btn");
            if (pipBtn) pipBtn.style.fontWeight = "400";
            redrawCanvas();
            updateInspector();
            return; // don't continue selection logic
          }
        }
        // if nothing sampled, still exit pipette mode
        editor.pipetteMode = false;
        const pipBtn = document.getElementById("pipette-btn");
        if (pipBtn) pipBtn.style.fontWeight = "400";
      }

      // cycle when clicking repeatedly near same spot
      const sameSpot =
        editor._lastHitCycle.mx !== null &&
        Math.hypot(editor._lastHitCycle.mx - mx, editor._lastHitCycle.my - my) <
          6;
      if (!sameSpot) {
        editor._lastHitCycle = { ids: hits.map((h) => h.id), pos: 0, mx, my };
      }

      if (hits.length) {
        // pick current index from cycle state
        const ids = hits.map((h) => h.id);
        // if previous stored ids don't match current hits, reset
        if (
          editor._lastHitCycle.ids.length !== ids.length ||
          editor._lastHitCycle.ids.some((id, i) => id !== ids[i])
        ) {
          editor._lastHitCycle = { ids, pos: 0, mx, my };
        }
        const pickIdx = editor._lastHitCycle.pos % hits.length;
        found = hits[pickIdx];
        // advance for next click
        editor._lastHitCycle.pos =
          (editor._lastHitCycle.pos + 1) % Math.max(1, hits.length);
      }

      // If nothing hit, check for transform handles (these may lie outside the shape bounds)
      if (!found) {
        for (let i = editor.scene.length - 1; i >= 0; i--) {
          const s = editor.scene[i];
          const localX = mx - s.x;
          const localY = my - s.y;
          const handle = editor._hitTestHandles(s, localX, localY);
          if (handle) {
            found = s;
            foundHandle = handle;
            break;
          }
        }
      } else {
        // also check if the chosen found has a handle at this point
        const localX = mx - found.x;
        const localY = my - found.y;
        const handleOnFound = editor._hitTestHandles(found, localX, localY);
        if (handleOnFound) foundHandle = handleOnFound;
      }

      if (found) {
        if (foundHandle) {
          if (!editor.selected.includes(found)) {
            if (!(event.shiftKey || event.ctrlKey || event.metaKey))
              editor.clearSelection();
            editor.select(found, true);
          }
          editor._startTransform(found, foundHandle.type, foundHandle, mx, my);
          // start coalescing history for transform drag
          editor.startCoalesce();
        } else {
          const multi = event.shiftKey || event.ctrlKey || event.metaKey;
          // respect layer lock: if found is locked, don't select or start dragging
          if (found._locked) {
            // if multi-select is requested and already selected, keep it; otherwise ignore
          } else {
            editor.select(found, multi);
            editor.dragging = true;
            editor.dragStart = { x: mx, y: my };
            // coalesce history while dragging
            editor.startCoalesce();
          }
        }
      } else {
        // start marquee selection when clicking empty area
        const ev = window.event || {};
        const multi = ev.shiftKey || ev.ctrlKey || ev.metaKey;
        // record whether user held a modifier at lasso start (Ctrl/Cmd/Shift)
        const ctrlHeld = ev.ctrlKey || ev.metaKey || ev.shiftKey;
        editor.marqueeActive = true;
        editor.marquee = { x0: mx, y0: my, x1: mx, y1: my, multi, ctrlHeld };
        // don't immediately clear selection if multi-select is requested
        if (!multi) editor.clearSelection();
      }
      updateInspector();
      redrawCanvas();
    } else if (editor.mode === "vertex") {
      // find the nearest vertex across all shapes (topmost priority)
      let best = null;
      const ev = window.event || {};
      const threshold = 10;

      const localToWorld = (s, lx, ly) => {
        let vx = lx;
        let vy = ly;
        if (s.scale && s.scale !== 1) {
          vx *= s.scale;
          vy *= s.scale;
        }
        if (s.rotation) {
          const ca = Math.cos(s.rotation);
          const sa = Math.sin(s.rotation);
          const wx = vx * ca - vy * sa;
          const wy = vx * sa + vy * ca;
          vx = wx;
          vy = wy;
        }
        return { x: vx + (s.x || 0), y: vy + (s.y || 0) };
      };

      for (let si = editor.scene.length - 1; si >= 0; si--) {
        const s = editor.scene[si];
        if (!s || s.type === "group") continue;

        if (s.vertices && s.vertices.length) {
          for (let i = 0; i < s.vertices.length; i++) {
            const v = s.vertices[i];
            const w = localToWorld(s, v.x, v.y);
            const d = Math.hypot(mx - w.x, my - w.y);
            if (d <= threshold) {
              if (!best || d < best.dist || (d === best.dist && si > best.si)) {
                best = { kind: "vertex", shape: s, index: i, dist: d, si };
              }
            }
          }
        } else if (s.commands && s.commands.length) {
          for (let ci = 0; ci < s.commands.length; ci++) {
            const c = s.commands[ci];
            if (!c) continue;

            let candidates = [];
            if (c.type === "line") {
              candidates = [
                { x: c.x1, y: c.y1, xProp: "x1", yProp: "y1" },
                { x: c.x2, y: c.y2, xProp: "x2", yProp: "y2" },
              ];
            } else if (c.type === "bezier") {
              candidates = [
                { x: c.x1, y: c.y1, xProp: "x1", yProp: "y1" },
                { x: c.x2, y: c.y2, xProp: "x2", yProp: "y2" },
                { x: c.x3, y: c.y3, xProp: "x3", yProp: "y3" },
                { x: c.x4, y: c.y4, xProp: "x4", yProp: "y4" },
              ];
            } else {
              continue;
            }

            for (const pt of candidates) {
              const w = localToWorld(s, pt.x, pt.y);
              const d = Math.hypot(mx - w.x, my - w.y);
              if (d <= threshold) {
                if (
                  !best ||
                  d < best.dist ||
                  (d === best.dist && si > best.si)
                ) {
                  best = {
                    kind: "cmd-point",
                    shape: s,
                    cmdIndex: ci,
                    xProp: pt.xProp,
                    yProp: pt.yProp,
                    dist: d,
                    si,
                  };
                }
              }
            }
          }
        }

        if (best && best.dist < 4) break;
      }
      if (best) {
        // If no modifier, select only the shape containing the vertex
        const multi = ev.shiftKey || ev.ctrlKey || ev.metaKey;
        if (!multi) {
          editor.clearSelection();
        }
        // ensure the shape is selected (single selection unless multi)
        editor.select(best.shape, !!multi);
        // set as selected vertex and start dragging
        if (best.kind === "vertex") {
          editor._selectedVertex = { shape: best.shape, index: best.index };
          editor._selectedCmdPoint = null;
          editor.vertexDrag = {
            kind: "vertex",
            shape: best.shape,
            index: best.index,
          };
        } else {
          editor._selectedVertex = null;
          editor._selectedCmdPoint = {
            shape: best.shape,
            cmdIndex: best.cmdIndex,
            xProp: best.xProp,
            yProp: best.yProp,
          };
          editor.vertexDrag = {
            kind: "cmd-point",
            shape: best.shape,
            cmdIndex: best.cmdIndex,
            xProp: best.xProp,
            yProp: best.yProp,
          };
        }
        editor.startCoalesce();
        redrawCanvas();
        updateInspector();
        return;
      }
    }
    // handle lasso start
    if (editor.mode === "lasso") {
      editor.lassoPoints = [{ x: mx, y: my }];
      editor.lassoActive = true;
      // clear selection unless shift held
      const ev = window.event || {};
      if (!(ev.shiftKey || ev.ctrlKey || ev.metaKey)) editor.clearSelection();
      redrawCanvas();
    }
  };

  p.mouseDragged = () => {
    const mx = p.mouseX - p.width / 2;
    const my = p.mouseY - p.height / 2;

    // draw tools
    if (editor.mode === "draw-line") {
      if (editor.drawTool && editor.drawTool.active) {
        editor.drawTool.current = { x: mx, y: my };
        editor.drawTool.cursor = { x: mx, y: my };
        redrawCanvas();
      }
      return;
    }
    if (editor.mode === "draw-bezier") {
      if (editor.drawTool) editor.drawTool.cursor = { x: mx, y: my };
      redrawCanvas();
      return;
    }

    if (editor.transformDrag) {
      editor._applyTransform(mx, my);
      redrawCanvas();
      updateInspector();
      return;
    }
    if (editor.mode === "select" && editor.dragging && editor.dragStart) {
      const dx = mx - editor.dragStart.x;
      const dy = my - editor.dragStart.y;
      editor.selected.forEach((s) => {
        s.x += dx;
        s.y += dy;
        // snap if enabled and snap-while-dragging is true
        const snapEl = document.getElementById("snap-to-grid");
        const gridEl = document.getElementById("grid-size");
        const snapWhile = document.getElementById("snap-while-dragging");
        if (
          snapEl &&
          snapEl.checked &&
          snapWhile &&
          snapWhile.checked &&
          gridEl
        ) {
          const gs = parseInt(gridEl.value) || 10;
          s.x = Math.round(s.x / gs) * gs;
          s.y = Math.round(s.y / gs) * gs;
        }
      });
      editor.dragStart = { x: mx, y: my };
      editor.movedDuringInteraction = true;
      // compute alignment guides for current selection if guides enabled
      try {
        const showGuides = document.getElementById("show-guides");
        if (showGuides && showGuides.checked)
          editor._computeAlignmentGuides(editor.selected.slice());
      } catch (e) {}
      redrawCanvas();
      updateInspector();
    } else if (editor.marqueeActive) {
      // update marquee rect
      editor.marquee.x1 = mx;
      editor.marquee.y1 = my;
      // start animation if not already
      if (!editor._marqueeAnimating) {
        editor._marqueeAnimating = true;
        p.loop();
      }
      redrawCanvas();
      updateInspector();
    } else if (editor.mode === "vertex" && editor.vertexDrag) {
      const drag = editor.vertexDrag;
      const s = drag.shape;
      // convert mouse point into shape local coords (inverse transform)
      let lx = mx - s.x;
      let ly = my - s.y;
      if (s.scale && s.scale !== 1) {
        lx /= s.scale;
        ly /= s.scale;
      }
      if (s.rotation) {
        const ca = Math.cos(-s.rotation);
        const sa = Math.sin(-s.rotation);
        const nx = lx * ca - ly * sa;
        const ny = lx * sa + ly * ca;
        lx = nx;
        ly = ny;
      }
      if (drag.kind === "cmd-point") {
        const c = s.commands && s.commands[drag.cmdIndex];
        if (c) {
          c[drag.xProp] = lx;
          c[drag.yProp] = ly;
        }
      } else {
        const i = drag.index;
        if (s.vertices && s.vertices[i]) {
          s.vertices[i].x = lx;
          s.vertices[i].y = ly;
        }
      }
      redrawCanvas();
      updateInspector();
    }

    // lasso continue
    if (editor.mode === "lasso" && editor.lassoActive) {
      editor.lassoPoints.push({ x: mx, y: my });
      redrawCanvas();
      updateInspector();
    }
  };

  p.mouseMoved = () => {
    const mx = p.mouseX - p.width / 2;
    const my = p.mouseY - p.height / 2;

    if (editor.mode === "draw-bezier") {
      if (editor.drawTool) editor.drawTool.cursor = { x: mx, y: my };
      redrawCanvas();
      return;
    }
    if (editor.mode === "draw-line") {
      if (editor.drawTool && editor.drawTool.active) {
        editor.drawTool.current = { x: mx, y: my };
        editor.drawTool.cursor = { x: mx, y: my };
        redrawCanvas();
      }
      return;
    }

    // only active in vertex mode
    editor._hoverVertex = null;
    editor._hoverEdge = null;
    // helper to show a floating micro-hint
    function showHint(text, screenX, screenY) {
      const h = document.getElementById("tool-hint");
      if (!h) return;
      h.textContent = text;
      h.style.left = Math.max(4, screenX + 12) + "px";
      h.style.top = Math.max(4, screenY + 12) + "px";
      h.style.display = "block";
    }
    function hideHint() {
      const h = document.getElementById("tool-hint");
      if (!h) return;
      h.style.display = "none";
    }
    // default cursor
    document.body.style.cursor = "default";
    hideHint();
    if (editor.mode === "vertex") {
      // search top-first across the entire scene for hover (so users can hover vertices even when not pre-selected)
      let best = null;
      for (let si = editor.scene.length - 1; si >= 0; si--) {
        const s = editor.scene[si];
        if (!s || !s.vertices || !s.vertices.length) continue;
        // check vertices
        for (let i = 0; i < s.vertices.length; i++) {
          let vx = s.vertices[i].x;
          let vy = s.vertices[i].y;
          if (s.scale && s.scale !== 1) {
            vx *= s.scale;
            vy *= s.scale;
          }
          if (s.rotation) {
            const ca = Math.cos(s.rotation),
              sa = Math.sin(s.rotation);
            const wx = vx * ca - vy * sa;
            const wy = vx * sa + vy * ca;
            vx = wx;
            vy = wy;
          }
          const wx = vx + s.x;
          const wy = vy + s.y;
          const d = Math.hypot(mx - wx, my - wy);
          if (d < 10) {
            // prefer closer and top-most (si larger)
            if (!best || d < best.dist || (d === best.dist && si > best.si)) {
              best = { shape: s, index: i, x: wx, y: wy, dist: d, si };
            }
          }
        }
        // if a very-close vertex on a top shape found, stop early
        if (best && best.dist < 4) break;
      }
      if (best) {
        editor._hoverVertex = {
          shape: best.shape,
          index: best.index,
          x: best.x,
          y: best.y,
        };
        // set pointer cursor and hint
        document.body.style.cursor = "pointer";
        const screenX = best.x + p.width / 2;
        const screenY = best.y + p.height / 2;
        showHint(
          "Drag vertex — click to select\nDel to remove",
          screenX,
          screenY
        );
        return;
      }

      // check edges top-first
      let bestEdge = null;
      for (let si = editor.scene.length - 1; si >= 0; si--) {
        const s = editor.scene[si];
        if (!s || !s.vertices || !s.vertices.length) continue;
        for (let i = 0; i < s.vertices.length; i++) {
          const a = s.vertices[i];
          const b = s.vertices[(i + 1) % s.vertices.length];
          // world coords
          let ax = a.x,
            ay = a.y,
            bx = b.x,
            by = b.y;
          if (s.scale && s.scale !== 1) {
            ax *= s.scale;
            ay *= s.scale;
            bx *= s.scale;
            by *= s.scale;
          }
          if (s.rotation) {
            const ca = Math.cos(s.rotation),
              sa = Math.sin(s.rotation);
            const aWx = ax * ca - ay * sa;
            const aWy = ax * sa + ay * ca;
            ax = aWx;
            ay = aWy;
            const bWx = bx * ca - by * sa;
            const bWy = bx * sa + by * ca;
            bx = bWx;
            by = bWy;
          }
          const axw = ax + s.x,
            ayw = ay + s.y,
            bxw = bx + s.x,
            byw = by + s.y;
          const proj = pointToSegmentProjection(
            { x: mx, y: my },
            { x: axw, y: ayw },
            { x: bxw, y: byw }
          );
          if (proj && proj.dist <= 8) {
            // prefer top-most
            if (!bestEdge || proj.dist < bestEdge.dist || si > bestEdge.si) {
              bestEdge = {
                shape: s,
                i: i,
                ax: axw,
                ay: ayw,
                bx: bxw,
                by: byw,
                px: proj.x,
                py: proj.y,
                dist: proj.dist,
                si,
              };
            }
          }
        }
        if (bestEdge && bestEdge.dist < 4) break;
      }
      if (bestEdge) {
        editor._hoverEdge = bestEdge;
        // show add-vertex hint on edge
        document.body.style.cursor = "copy";
        const screenX = bestEdge.px + p.width / 2;
        const screenY = bestEdge.py + p.height / 2;
        showHint("Add vertex (click)", screenX, screenY);
        return;
      }
    }

    // when not in vertex mode, offer handle/tool hints and cursor feedback
    // compute transform handle hover for selected item
    try {
      if (editor.mode === "select") {
        // find top-most handle under cursor
        for (let si = editor.scene.length - 1; si >= 0; si--) {
          const s = editor.scene[si];
          const lx = mx - s.x;
          const ly = my - s.y;
          const h = editor._hitTestHandles(s, lx, ly);
          if (h) {
            // choose cursor and hint text per handle type
            if (h.type === "rotate") {
              document.body.style.cursor = "crosshair";
              const screenX = h.cx + s.x + p.width / 2;
              const screenY = h.cy + s.y + p.height / 2 - 24;
              showHint("Rotate — drag to rotate", screenX, screenY);
            } else if (h.type === "scale") {
              document.body.style.cursor = "nwse-resize";
              const screenX = h.cx + s.x + p.width / 2;
              const screenY = h.cy + s.y + p.height / 2;
              showHint("Resize — drag corner", screenX, screenY);
            } else if (h.type === "ellipse-scale") {
              document.body.style.cursor = "nwse-resize";
              const screenX = s.x + p.width / 2 + (h.cx || 0);
              const screenY = s.y + p.height / 2 + (h.cy || 0);
              showHint("Resize ellipse — drag handle", screenX, screenY);
            }
            return;
          }
        }
        // otherwise when hovering a selected shape, indicate move
        const hits = editor.findAllAt(mx, my);
        if (hits && hits.length) {
          document.body.style.cursor = "move";
          const top = hits[0];
          const b =
            top.type === "group"
              ? editor._groupBounds(top)
              : top._computeBounds();
          if (b) {
            const sx = (top.x || 0) + b.x + p.width / 2;
            const sy = (top.y || 0) + b.y + p.height / 2;
            showHint("Move — drag to move", sx, sy - 20);
          }
        }
      }
      // lasso cursor
      if (editor.mode === "lasso") {
        document.body.style.cursor = "crosshair";
        showHint(
          "Lasso — draw to select (hold Ctrl/Shift for contains)",
          p.width / 2 + mx,
          p.height / 2 + my
        );
      }
    } catch (e) {}
  };

  function pointToSegmentProjection(p, a, b) {
    const vx = b.x - a.x,
      vy = b.y - a.y;
    const wx = p.x - a.x,
      wy = p.y - a.y;
    const c1 = vx * wx + vy * wy;
    const c2 = vx * vx + vy * vy;
    if (c2 === 0)
      return { x: a.x, y: a.y, dist: Math.hypot(p.x - a.x, p.y - a.y) };
    const t = Math.max(0, Math.min(1, c1 / c2));
    const px = a.x + t * vx,
      py = a.y + t * vy;
    return { x: px, y: py, t: t, dist: Math.hypot(p.x - px, p.y - py) };
  }

  p.mouseReleased = () => {
    // finalize line tool on mouse release
    if (
      editor &&
      editor.mode === "draw-line" &&
      editor.drawTool &&
      editor.drawTool.active
    ) {
      const a = editor.drawTool.start;
      const b = editor.drawTool.current;
      editor.drawTool.active = false;
      editor.drawTool.start = null;
      editor.drawTool.current = null;
      editor.drawTool.cursor = null;

      if (a && b) {
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (dist >= 2) {
          const cx = (a.x + b.x) / 2;
          const cy = (a.y + b.y) / 2;
          const strokeHex =
            (document.getElementById("stroke-color") || {}).value || "#362f38";
          const strokeOpacity =
            (document.getElementById("stroke-opacity") || {}).value || 100;
          const noStroke = (document.getElementById("no-stroke") || {}).checked;
          const sw = parseFloat(
            (document.getElementById("stroke-weight") || {}).value
          );
          const strokeVal = noStroke
            ? null
            : hexToRgbA(strokeHex, strokeOpacity);

          const s = new Shape({
            x: cx,
            y: cy,
            fill: null,
            stroke: strokeVal,
            strokeWeight: isNaN(sw) ? 2 : sw,
            commands: [
              {
                type: "line",
                x1: a.x - cx,
                y1: a.y - cy,
                x2: b.x - cx,
                y2: b.y - cy,
              },
            ],
          });
          editor.addShape(s);
          editor.clearSelection();
          editor.select(s);
          updateInspector();
        }
      }

      redrawCanvas();
      updateStatusBar();
      return;
    }

    if (editor.transformDrag) {
      editor._finishTransform();
      // finish coalesce after transform
      editor.finishCoalesce();
    }
    if (editor.dragging) {
      editor.dragging = false;
      if (editor.movedDuringInteraction) {
        // apply unified snapping behavior on drop (grid/guides)
        editor._applySnapOnDrop("drag");
        if (editor._coalescing) editor.finishCoalesce();
        else editor.pushHistory();
      }
      editor.movedDuringInteraction = false;
    }
    // finish marquee selection
    if (editor.marqueeActive && editor.marquee) {
      const m = editor.marquee;
      const rx = Math.min(m.x0, m.x1);
      const ry = Math.min(m.y0, m.y1);
      const rw = Math.abs(m.x1 - m.x0);
      const rh = Math.abs(m.y1 - m.y0);
      // select shapes whose bounds intersect/contain the marquee rect
      const hits = [];
      for (let i = 0; i < editor.scene.length; i++) {
        const s = editor.scene[i];
        if (s._locked) continue;
        const b =
          s.type === "group" ? editor._groupBounds(s) : s._computeBounds();
        if (!b) continue;
        const bx = (s.x || 0) + b.x;
        const by = (s.y || 0) + b.y;
        const bw = b.w;
        const bh = b.h;
        const fullyContained =
          bx >= rx && by >= ry && bx + bw <= rx + rw && by + bh <= ry + rh;
        const intersects = !(
          bx > rx + rw ||
          bx + bw < rx ||
          by > ry + rh ||
          by + bh < ry
        );
        if (m.ctrlHeld) {
          if (fullyContained) hits.push(s);
        } else {
          if (intersects) hits.push(s);
        }
      }
      if (hits.length) {
        if (!m.multi) editor.clearSelection();
        // if snap is enabled, align newly selected items to grid
        const snapEl = document.getElementById("snap-to-grid");
        const gridEl = document.getElementById("grid-size");
        hits.forEach((h) => {
          editor.select(h, true);
          if (snapEl && snapEl.checked && gridEl) {
            const gs = parseInt(gridEl.value) || 10;
            if (h.x !== undefined) h.x = Math.round(h.x / gs) * gs;
            if (h.y !== undefined) h.y = Math.round(h.y / gs) * gs;
          }
        });
      }
      editor.marqueeActive = false;
      editor.marquee = null;
      // stop animation
      if (editor._marqueeAnimating) {
        editor._marqueeAnimating = false;
        p.noLoop();
      }
      redrawCanvas();
      updateInspector();
    }
    // if we were dragging a vertex, apply snap-on-drop for vertex edits
    if (editor.vertexDrag) {
      editor._applySnapOnDrop("vertex");
    }
    editor.vertexDrag = null;
    // clear hover state after release
    editor._hoverVertex = null;
    editor._hoverEdge = null;
    // finish lasso
    if (
      editor.lassoActive &&
      editor.lassoPoints &&
      editor.lassoPoints.length > 2
    ) {
      const poly = editor.lassoPoints.slice();
      const ev = window.event || {};
      const containsMode =
        (document.getElementById("marquee-contains") &&
          document.getElementById("marquee-contains").checked) ||
        ev.ctrlKey ||
        ev.metaKey;
      const hits = [];
      for (let s of editor.scene) {
        if (s._locked) continue;
        const verts = editor._getWorldVertices(s);
        if (verts && verts.length) {
          if (containsMode) {
            const allIn = verts.every((v) =>
              pointInPolygon({ x: v.x, y: v.y }, poly)
            );
            if (allIn) hits.push(s);
          } else {
            const anyIn = verts.some((v) =>
              pointInPolygon({ x: v.x, y: v.y }, poly)
            );
            if (anyIn) hits.push(s);
          }
        } else {
          // fallback to bbox intersection/contain test (convert bbox to world coords)
          const b =
            s.type === "group" ? editor._groupBounds(s) : s._computeBounds();
          if (!b) continue;
          const bx = (s.x || 0) + b.x;
          const by = (s.y || 0) + b.y;
          const bw = b.w;
          const bh = b.h;
          if (containsMode) {
            if (
              bx >= poly.reduce((m, p) => Math.min(m, p.x), Infinity) &&
              by >= poly.reduce((m, p) => Math.min(m, p.y), Infinity) &&
              bx + bw <= poly.reduce((m, p) => Math.max(m, p.x), -Infinity) &&
              by + bh <= poly.reduce((m, p) => Math.max(m, p.y), -Infinity)
            ) {
              hits.push(s);
            }
          } else {
            // bbox intersects polygon bbox
            const prx = Math.min(...poly.map((p) => p.x));
            const pry = Math.min(...poly.map((p) => p.y));
            const prw = Math.max(...poly.map((p) => p.x)) - prx;
            const prh = Math.max(...poly.map((p) => p.y)) - pry;
            const intersects = !(
              bx > prx + prw ||
              bx + bw < prx ||
              by > pry + prh ||
              by + bh < pry
            );
            if (intersects) hits.push(s);
          }
        }
      }
      if (hits.length) hits.forEach((h) => editor.select(h, true));
      editor.lassoActive = false;
      editor.lassoPoints = null;
      redrawCanvas();
      updateInspector();
    }
  };

  p.mouseClicked = () => {
    const mx = p.mouseX - p.width / 2;
    const my = p.mouseY - p.height / 2;
    if (editor.mode === "vertex") {
      // insert on hovered edge (hover search now considers all shapes)
      if (editor._hoverEdge) {
        const he = editor._hoverEdge;
        const s = he.shape;
        let lx = he.px - s.x;
        let ly = he.py - s.y;
        if (s.rotation) {
          const ca = Math.cos(-s.rotation),
            sa = Math.sin(-s.rotation);
          const nx = lx * ca - ly * sa;
          const ny = lx * sa + ly * ca;
          lx = nx;
          ly = ny;
        }
        if (s.scale && s.scale !== 1) {
          lx /= s.scale;
          ly /= s.scale;
        }
        s.vertices.splice(he.i + 1, 0, { x: lx, y: ly });
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
        return;
      }
      // select hovered vertex (optionally single-select the shape)
      if (editor._hoverVertex) {
        const hv = editor._hoverVertex;
        const ev = window.event || {};
        const multi = ev.shiftKey || ev.ctrlKey || ev.metaKey;
        if (!multi) editor.clearSelection();
        editor.select(hv.shape, !!multi);
        editor._selectedVertex = { shape: hv.shape, index: hv.index };
        redrawCanvas();
        updateInspector();
        return;
      }
    }
  };

  p.doubleClicked = () => {
    // add/remove vertex in vertex mode on double click
    const mx = p.mouseX - p.width / 2;
    const my = p.mouseY - p.height / 2;
    if (editor.mode !== "vertex") return;
    // target shape: prefer single selected, otherwise fall back to hovered shape
    let s = null;
    if (editor.selected.length === 1) s = editor.selected[0];
    else if (editor._hoverVertex) s = editor._hoverVertex.shape;
    else if (editor._hoverEdge) s = editor._hoverEdge.shape;
    if (!s) return;
    if (!s.vertices || !Array.isArray(s.vertices)) return;
    const ev = window.event || {};
    // find nearest vertex (use world coords computed from local + transform)
    let nearestIdx = -1;
    let nearestD = Infinity;
    for (let i = 0; i < s.vertices.length; i++) {
      const v = s.vertices[i];
      // world pos
      let vx = v.x;
      let vy = v.y;
      if (s.scale && s.scale !== 1) {
        vx *= s.scale;
        vy *= s.scale;
      }
      if (s.rotation) {
        const ca = Math.cos(s.rotation);
        const sa = Math.sin(s.rotation);
        const wx = vx * ca - vy * sa;
        const wy = vx * sa + vy * ca;
        vx = wx;
        vy = wy;
      }
      vx = vx + s.x;
      vy = vy + s.y;
      const d = Math.hypot(mx - vx, my - vy);
      if (d < nearestD) {
        nearestD = d;
        nearestIdx = i;
      }
    }
    if (ev.altKey) {
      // remove if close
      if (nearestD < 12 && s.vertices.length > 3) {
        s.vertices.splice(nearestIdx, 1);
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      }
      return;
    }
    // add vertex: find nearest edge to insert (compute segment world positions)
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < s.vertices.length; i++) {
      const a = s.vertices[i];
      const b = s.vertices[(i + 1) % s.vertices.length];
      const axWorld = a.x * (s.scale || 1);
      const ayWorld = a.y * (s.scale || 1);
      const bxWorld = b.x * (s.scale || 1);
      const byWorld = b.y * (s.scale || 1);
      // rotate
      let ax = axWorld,
        ay = ayWorld,
        bx = bxWorld,
        by = byWorld;
      if (s.rotation) {
        const ca = Math.cos(s.rotation);
        const sa = Math.sin(s.rotation);
        const aWx = ax * ca - ay * sa;
        const aWy = ax * sa + ay * ca;
        const bWx = bx * ca - by * sa;
        const bWy = bx * sa + by * ca;
        ax = aWx;
        ay = aWy;
        bx = bWx;
        by = bWy;
      }
      const axw = ax + s.x,
        ayw = ay + s.y,
        bxw = bx + s.x,
        byw = by + s.y;
      const dist = pointToSegmentDistance(
        { x: mx, y: my },
        { x: axw, y: ayw },
        { x: bxw, y: byw }
      );
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i + 1;
      }
    }
    if (bestDist < 20) {
      // insert vertex at local coords (inverse transform the click point)
      let lx = mx - s.x;
      let ly = my - s.y;
      if (s.scale && s.scale !== 1) {
        lx /= s.scale;
        ly /= s.scale;
      }
      if (s.rotation) {
        const ca = Math.cos(-s.rotation);
        const sa = Math.sin(-s.rotation);
        const nx = lx * ca - ly * sa;
        const ny = lx * sa + ly * ca;
        lx = nx;
        ly = ny;
      }
      s.vertices.splice(bestIdx, 0, { x: lx, y: ly });
      editor.pushHistory();
      redrawCanvas();
      updateInspector();
    }
  };

  function pointToSegmentDistance(p, a, b) {
    const vx = b.x - a.x,
      vy = b.y - a.y;
    const wx = p.x - a.x,
      wy = p.y - a.y;
    const c1 = vx * wx + vy * wy;
    if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const c2 = vx * vx + vy * vy;
    if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);
    const t = c1 / c2;
    const projx = a.x + t * vx,
      projy = a.y + t * vy;
    return Math.hypot(p.x - projx, p.y - projy);
  }

  function redrawCanvas() {
    p.clear();
    p.background(245, 240, 250);
    p.push();
    p.translate(p.width / 2, p.height / 2);
    // draw optional grid behind shapes if enabled
    try {
      const showGridEl = document.getElementById("show-grid");
      const gridEl = document.getElementById("grid-size");
      if (showGridEl && showGridEl.checked && gridEl) {
        const gs = parseInt(gridEl.value) || 10;
        const majorStepEl = document.getElementById("grid-major-step");
        const major = majorStepEl
          ? Math.max(1, parseInt(majorStepEl.value) || 5)
          : 5;
        p.push();
        p.translate(-p.width / 2, -p.height / 2); // draw in screen coords
        p.noFill();
        // minor lines
        p.stroke(220);
        p.strokeWeight(1);
        for (let x = 0; x <= p.width; x += gs) p.line(x, 0, x, p.height);
        for (let y = 0; y <= p.height; y += gs) p.line(0, y, p.width, y);
        // major lines (darker)
        p.stroke(200);
        p.strokeWeight(1.5);
        for (let x = 0; x <= p.width; x += gs * major)
          p.line(x, 0, x, p.height);
        for (let y = 0; y <= p.height; y += gs * major)
          p.line(0, y, p.width, y);
        p.pop();
      }
    } catch (e) {}
    editor.draw();

    // draw tool previews (in centered coords)
    try {
      const dt = editor.drawTool;
      if (
        editor.mode === "draw-line" &&
        dt &&
        dt.kind === "line" &&
        dt.active &&
        dt.start &&
        dt.current
      ) {
        p.push();
        p.noFill();
        p.stroke(0, 120, 255);
        p.strokeWeight(2);
        p.line(dt.start.x, dt.start.y, dt.current.x, dt.current.y);
        p.pop();
      }

      if (editor.mode === "draw-bezier" && dt && dt.kind === "bezier") {
        const pts = dt.points || [];
        const cur = dt.cursor;
        if (pts.length && cur) {
          const all = pts.concat([{ x: cur.x, y: cur.y }]);
          p.push();
          p.noFill();
          p.stroke(0, 120, 255);
          p.strokeWeight(2);

          if (all.length === 2) {
            p.line(all[0].x, all[0].y, all[1].x, all[1].y);
          } else if (all.length === 3) {
            p.line(all[0].x, all[0].y, all[1].x, all[1].y);
            p.line(all[1].x, all[1].y, all[2].x, all[2].y);
          } else if (all.length >= 4) {
            p.bezier(
              all[0].x,
              all[0].y,
              all[1].x,
              all[1].y,
              all[2].x,
              all[2].y,
              all[3].x,
              all[3].y
            );
            // control handle lines
            p.stroke(0, 120, 255, 120);
            p.strokeWeight(1);
            p.line(all[0].x, all[0].y, all[1].x, all[1].y);
            p.line(all[2].x, all[2].y, all[3].x, all[3].y);
          }

          // points
          p.noStroke();
          p.fill(0, 120, 255);
          pts.forEach((pt) => p.circle(pt.x, pt.y, 6));
          p.fill(0, 120, 255, 140);
          p.circle(cur.x, cur.y, 6);
          p.pop();
        }
      }
    } catch (e) {}
    p.pop();
    // draw marquee rectangle (in screen coords)
    if (editor.marqueeActive && editor.marquee) {
      const m = editor.marquee;
      // convert centered coords to screen
      const sx0 = m.x0 + p.width / 2;
      const sy0 = m.y0 + p.height / 2;
      const sx1 = m.x1 + p.width / 2;
      const sy1 = m.y1 + p.height / 2;
      const rx = Math.min(sx0, sx1);
      const ry = Math.min(sy0, sy1);
      const rw = Math.abs(sx1 - sx0);
      const rh = Math.abs(sy1 - sy0);
      p.push();
      p.noFill();
      p.stroke(0, 120, 255);
      p.strokeWeight(1);
      p.rectMode(p.CORNER);
      const ctx = p.drawingContext;
      try {
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -editor._marqueeDashOffset;
      } catch (e) {}
      p.rect(rx, ry, rw, rh);
      try {
        ctx.setLineDash([]);
      } catch (e) {}
      p.pop();
      if (editor._marqueeAnimating)
        editor._marqueeDashOffset = (editor._marqueeDashOffset + 1) % 1000;
    }
    // draw lasso if active
    if (editor.lassoActive && editor.lassoPoints && editor.lassoPoints.length) {
      p.push();
      p.noFill();
      p.stroke(0, 120, 255);
      p.strokeWeight(1);
      const ctx = p.drawingContext;
      try {
        ctx.setLineDash([6, 4]);
      } catch (e) {}
      for (let i = 0; i < editor.lassoPoints.length - 1; i++) {
        const a = editor.lassoPoints[i];
        const b = editor.lassoPoints[i + 1];
        p.line(
          a.x + p.width / 2,
          a.y + p.height / 2,
          b.x + p.width / 2,
          b.y + p.height / 2
        );
      }
      try {
        ctx.setLineDash([]);
      } catch (e) {}
      p.pop();
    }
  }

  // point-in-polygon using ray-casting
  function pointInPolygon(point, vs) {
    let x = point.x,
      y = point.y;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      const xi = vs[i].x,
        yi = vs[i].y;
      const xj = vs[j].x,
        yj = vs[j].y;
      const intersect =
        yi > y !== yj > y &&
        x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0000001) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ---------------- UI wiring ----------------
  function showNotification(message, type = "success") {
    const notification = document.getElementById("notification");
    if (notification) {
      notification.textContent = message;
      notification.className = `notification ${type}`;
      notification.style.display = "block";
      notification.style.transform = "translateX(0)";
      setTimeout(() => {
        notification.style.transform = "translateX(400px)";
        setTimeout(() => {
          notification.style.display = "none";
        }, 300);
      }, 3000);
    }
  }

  function updateStatusBar() {
    const toolEl = document.getElementById("status-tool");
    const selectionEl = document.getElementById("status-selection");
    const zoomEl = document.getElementById("status-zoom");
    if (toolEl) {
      let modeName = "Select";
      if (editor.mode === "vertex") modeName = "Vertex Edit";
      else if (editor.mode === "lasso") modeName = "Lasso";
      else if (editor.mode === "draw-line") modeName = "Draw Line";
      else if (editor.mode === "draw-bezier") modeName = "Draw Bezier";
      toolEl.textContent = "Tool: " + modeName;
    }
    if (selectionEl) {
      selectionEl.textContent =
        "Selection: " + editor.selected.length + " items";
    }
    if (zoomEl) {
      zoomEl.textContent = "Zoom: 100%"; // placeholder, can add zoom later
    }
  }

  function wireUI() {
    document.getElementById("tool-select").addEventListener("click", () => {
      // keep selection when toggling tools
      const prevSel = editor.selected.slice();
      editor.mode = "select";
      // cancel any in-progress draw tool
      if (editor.drawTool) {
        editor.drawTool.kind = null;
        editor.drawTool.active = false;
        editor.drawTool.points = [];
        editor.drawTool.start = null;
        editor.drawTool.current = null;
        editor.drawTool.cursor = null;
      }
      editor.selected = prevSel;
      updateModeButtons();
      updateInspector();
      updateStatusBar();
      redrawCanvas();
    });
    document.getElementById("tool-vertex").addEventListener("click", () => {
      // switch to vertex mode. If nothing selected, pick a sensible default shape to edit
      const prevSel = editor.selected.slice();
      editor.mode = "vertex";
      // cancel any in-progress draw tool
      if (editor.drawTool) {
        editor.drawTool.kind = null;
        editor.drawTool.active = false;
        editor.drawTool.points = [];
        editor.drawTool.start = null;
        editor.drawTool.current = null;
        editor.drawTool.cursor = null;
      }
      if (!prevSel || prevSel.length === 0) {
        // choose topmost editable shape (last in scene that is not a group and is visible)
        let picked = null;
        for (let i = editor.scene.length - 1; i >= 0; i--) {
          const c = editor.scene[i];
          if (!c) continue;
          if (c.type === "group") continue;
          if (c.visible === false) continue;
          // pick this one
          picked = c;
          break;
        }
        if (picked) {
          editor.clearSelection();
          editor.select(picked, false);
        }
      } else {
        editor.selected = prevSel;
      }
      updateModeButtons();
      updateInspector();
      updateStatusBar();
      redrawCanvas();
    });
    // ...existing modal add handlers are declared further down inside the Add Shape modal block

    // Add Shape modal wiring
    const addShapeBtn = document.getElementById("add-shape");
    const modal = document.getElementById("add-shape-modal");
    if (addShapeBtn && modal) {
      addShapeBtn.addEventListener("click", () => {
        modal.style.display = "flex";
      });
      document.getElementById("modal-close").addEventListener("click", () => {
        modal.style.display = "none";
      });
      document
        .getElementById("modal-add-ellipse")
        .addEventListener("click", () => {
          const s = new Shape({
            x: 0,
            y: 0,
            commands: [{ type: "ellipse", x: 0, y: 0, w: 120, h: 80 }],
            fill: document.getElementById("fill-color").value,
            stroke: document.getElementById("stroke-color").value,
            strokeWeight: (function () {
              const v = parseFloat(
                document.getElementById("stroke-weight").value
              );
              return isNaN(v) ? 1 : v;
            })(),
          });
          editor.addShape(s);
          modal.style.display = "none";
          redrawCanvas();
        });
      document
        .getElementById("modal-add-rect")
        .addEventListener("click", () => {
          const s = new Shape({
            x: 0,
            y: 0,
            commands: [{ type: "rect", x: 0, y: 0, w: 160, h: 100 }],
            fill: document.getElementById("fill-color").value,
            stroke: document.getElementById("stroke-color").value,
            strokeWeight: (function () {
              const v = parseFloat(
                document.getElementById("stroke-weight").value
              );
              return isNaN(v) ? 1 : v;
            })(),
          });
          editor.addShape(s);
          modal.style.display = "none";
          redrawCanvas();
        });
      document
        .getElementById("modal-add-polygon")
        .addEventListener("click", () => {
          const verts = [
            { x: -60, y: -40 },
            { x: 60, y: -40 },
            { x: 80, y: 40 },
            { x: -80, y: 40 },
          ];
          const s = new Shape({
            x: 0,
            y: 0,
            vertices: verts,
            fill: document.getElementById("fill-color").value,
            stroke: document.getElementById("stroke-color").value,
            strokeWeight: (function () {
              const v = parseFloat(
                document.getElementById("stroke-weight").value
              );
              return isNaN(v) ? 1 : v;
            })(),
          });
          editor.addShape(s);
          modal.style.display = "none";
          redrawCanvas();
        });

      document
        .getElementById("modal-add-line")
        .addEventListener("click", () => {
          editor.mode = "draw-line";
          editor.drawTool.kind = "line";
          editor.drawTool.active = false;
          editor.drawTool.points = [];
          editor.drawTool.start = null;
          editor.drawTool.current = null;
          editor.drawTool.cursor = null;
          modal.style.display = "none";
          updateModeButtons();
          updateStatusBar();
          redrawCanvas();
        });

      document
        .getElementById("modal-add-bezier")
        .addEventListener("click", () => {
          editor.mode = "draw-bezier";
          editor.drawTool.kind = "bezier";
          editor.drawTool.active = false;
          editor.drawTool.points = [];
          editor.drawTool.start = null;
          editor.drawTool.current = null;
          editor.drawTool.cursor = null;
          modal.style.display = "none";
          updateModeButtons();
          updateStatusBar();
          redrawCanvas();
        });
      document
        .getElementById("modal-add-text")
        .addEventListener("click", () => {
          const s = new Shape({
            x: 0,
            y: 0,
            commands: [
              { type: "text", x: 0, y: 0, content: "Hello", size: 32 },
            ],
            fill: document.getElementById("fill-color").value,
            stroke: null,
          });
          editor.addShape(s);
          modal.style.display = "none";
          redrawCanvas();
        });
      document
        .getElementById("modal-add-image")
        .addEventListener("click", () => {
          const url = prompt("Image URL or local path (http/https):");
          if (!url) return;
          // clamp initial image size to canvas so large defaults don't overflow
          const maxW = editor && editor.p ? editor.p.width : 800;
          const maxH = editor && editor.p ? editor.p.height : 800;
          const initW = Math.min(200, maxW);
          const initH = Math.min(150, maxH);
          const s = new Shape({
            x: 0,
            y: 0,
            commands: [
              { type: "image", x: 0, y: 0, src: url, w: initW, h: initH },
            ],
          });
          s.commands.forEach((c) => {
            if (c.type === "image") editor._loadImageForCommand(c);
          });
          editor.addShape(s);
          modal.style.display = "none";
          redrawCanvas();
        });
    }

    document.getElementById("group-btn").addEventListener("click", () => {
      editor.groupSelected();
      redrawCanvas();
      updateInspector();
    });

    // Contextual toolbar: keep a safe render function that no-ops when the DOM element is absent.
    const ctxToolbar = document.getElementById("context-toolbar");
    function renderContextToolbar() {
      if (!ctxToolbar) return;
      ctxToolbar.innerHTML = "";
      if (editor.mode === "select") {
        // show transform quick actions
        const html = `
          <div style="display:flex; gap:6px;">
            <button id="ctx-align-left">Align L</button>
            <button id="ctx-align-center">Align C</button>
            <button id="ctx-align-right">Align R</button>
            <button id="ctx-distribute-h">Dist H</button>
          </div>
        `;
        ctxToolbar.innerHTML = html;
        // wire small actions
        document
          .getElementById("ctx-align-left")
          .addEventListener("click", () => {
            document.getElementById("align-left").click();
          });
        document
          .getElementById("ctx-align-center")
          .addEventListener("click", () => {
            document.getElementById("align-center").click();
          });
        document
          .getElementById("ctx-align-right")
          .addEventListener("click", () => {
            document.getElementById("align-right").click();
          });
        document
          .getElementById("ctx-distribute-h")
          .addEventListener("click", () => {
            document.getElementById("distribute-h").click();
          });
        // show Apply Scale when a single selected item has non-1 scale
        const showApply =
          editor.selected.length === 1 &&
          editor.selected[0].scale &&
          editor.selected[0].scale !== 1;
        if (showApply) {
          const btn = document.createElement("button");
          btn.textContent = "Apply Scale";
          btn.style.marginLeft = "8px";
          btn.addEventListener("click", () => {
            editor.applyScaleToSelection();
            renderContextToolbar();
            updateInspector();
          });
          ctxToolbar.appendChild(btn);
        }
      } else if (editor.mode === "vertex") {
        const html = `
          <div style="display:flex; gap:6px;">
            <button id="ctx-add-vertex">Add Vertex</button>
            <button id="ctx-remove-vertex">Remove Vertex</button>
          </div>
        `;
        ctxToolbar.innerHTML = html;
        document
          .getElementById("ctx-add-vertex")
          .addEventListener("click", () => {
            /* double-click behavior not wired */ showNotification(
              "Double-click on edge to add vertex"
            );
          });
        document
          .getElementById("ctx-remove-vertex")
          .addEventListener("click", () => {
            showNotification("Alt+Double-click on vertex to remove");
          });
      }
    }
    renderContextToolbar();

    document.getElementById("btn-undo").addEventListener("click", () => {
      editor.undo();
      redrawCanvas();
      updateInspector();
    });
    document.getElementById("btn-redo").addEventListener("click", () => {
      editor.redo();
      redrawCanvas();
      updateInspector();
    });

    // History modal wiring
    const openHist = document.getElementById("open-history-modal");
    const historyModal = document.getElementById("history-modal");
    const historyList = document.getElementById("history-list");
    const historyClose = document.getElementById("history-close");
    function renderHistoryList() {
      if (!historyList || !editor || !editor.history) return;
      historyList.innerHTML = "";
      for (let i = 0; i < editor.history.length; i++) {
        const li = document.createElement("div");
        li.style.padding = "6px";
        li.style.borderBottom = "1px solid #f1f1f1";
        li.style.cursor = "pointer";
        li.textContent = `#${i + 1} — ${new Date().toLocaleTimeString()}`;
        li.dataset.idx = i;
        li.addEventListener("click", () => {
          // jump to history entry
          if (
            !confirm(
              "Revert to this history state? This will discard newer states."
            )
          )
            return;
          editor.jumpToHistory(parseInt(li.dataset.idx));
          redrawCanvas();
          updateInspector();
        });
        historyList.appendChild(li);
      }
    }

    // expose an updater so pushHistory can refresh the list (modal + inline)
    window.updateHistoryPanel = function () {
      try {
        renderHistoryList();
      } catch (e) {}
      try {
        const inline = document.getElementById("history-inline-list");
        if (inline && editor && editor.history) {
          inline.innerHTML = "";
          for (let i = 0; i < editor.history.length; i++) {
            const li = document.createElement("div");
            li.style.padding = "4px";
            li.style.borderBottom = "1px solid #f1f1f1";
            li.style.cursor = "pointer";
            li.textContent = `#${i + 1} — ${new Date().toLocaleTimeString()}`;
            li.dataset.idx = i;
            li.addEventListener("click", () => {
              if (
                !confirm(
                  "Revert to this history state? This will discard newer states."
                )
              )
                return;
              editor.jumpToHistory(parseInt(li.dataset.idx));
              redrawCanvas();
              updateInspector();
            });
            inline.appendChild(li);
          }
        }
      } catch (e) {}

      // wire inline undo/redo/open buttons (only once)
      try {
        const undoBtn = document.getElementById("btn-undo-inline");
        const redoBtn = document.getElementById("btn-redo-inline");
        const openBtn = document.getElementById("open-history-modal-inline");
        if (undoBtn && !undoBtn._wired) {
          undoBtn.addEventListener("click", () => {
            editor.undo();
            redrawCanvas();
            updateInspector();
          });
          undoBtn._wired = true;
        }
        if (redoBtn && !redoBtn._wired) {
          redoBtn.addEventListener("click", () => {
            editor.redo();
            redrawCanvas();
            updateInspector();
          });
          redoBtn._wired = true;
        }
        if (openBtn && !openBtn._wired) {
          openBtn.addEventListener("click", () => {
            const modal = document.getElementById("history-modal");
            if (modal) modal.style.display = "flex";
            renderHistoryList();
          });
          openBtn._wired = true;
        }
      } catch (e) {}
    };

    if (openHist && historyModal) {
      openHist.addEventListener("click", () => {
        historyModal.style.display = "flex";
        renderHistoryList();
      });
    }
    if (historyClose && historyModal) {
      historyClose.addEventListener("click", () => {
        historyModal.style.display = "none";
      });
    }

    // keyboard shortcuts for tools and help toggle (single-key shortcuts)
    window.addEventListener("keydown", (ev) => {
      if (!editor) return;
      // don't hijack input fields
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      )
        return;
      const k = ev.key.toLowerCase();
      // help overlay toggle: ? or h
      if (k === "?" || k === "h") {
        const help = document.getElementById("help-overlay");
        if (!help) return;
        help.style.display =
          help.style.display === "flex" || help.style.display === "block"
            ? "none"
            : "flex";
        ev.preventDefault();
        return;
      }
      if (k === "v") {
        document.getElementById("tool-select").click();
        renderContextToolbar();
        ev.preventDefault();
        return;
      }
      if (k === "e") {
        // add ellipse immediately
        const s = new Shape({
          x: 0,
          y: 0,
          commands: [{ type: "ellipse", x: 0, y: 0, w: 120, h: 80 }],
          fill: document.getElementById("fill-color")
            ? document.getElementById("fill-color").value
            : "#ffffff",
          stroke: document.getElementById("stroke-color")
            ? document.getElementById("stroke-color").value
            : "#000000",
          strokeWeight: (function () {
            const v = parseFloat(
              document.getElementById("stroke-weight").value
            );
            return isNaN(v) ? 1 : v;
          })(),
        });
        editor.addShape(s);
        redrawCanvas();
        ev.preventDefault();
        return;
      }
      if (k === "r") {
        // add rect immediately
        const s = new Shape({
          x: 0,
          y: 0,
          commands: [{ type: "rect", x: 0, y: 0, w: 160, h: 100 }],
          fill: document.getElementById("fill-color")
            ? document.getElementById("fill-color").value
            : "#ffffff",
          stroke: document.getElementById("stroke-color")
            ? document.getElementById("stroke-color").value
            : "#000000",
          strokeWeight: (function () {
            const v = parseFloat(
              document.getElementById("stroke-weight").value
            );
            return isNaN(v) ? 1 : v;
          })(),
        });
        editor.addShape(s);
        redrawCanvas();
        ev.preventDefault();
        return;
      }
      if (k === "p") {
        // toggle pipette mode
        editor.pipetteMode = !editor.pipetteMode;
        const pip = document.getElementById("pipette-btn");
        if (pip) pip.style.fontWeight = editor.pipetteMode ? "700" : "400";
        ev.preventDefault();
        return;
      }
      if (k === "g") {
        if (ev.ctrlKey) {
          // toggle grid visibility
          const showGridEl = document.getElementById("show-grid");
          if (showGridEl) {
            showGridEl.checked = !showGridEl.checked;
            editor.gridVisible = showGridEl.checked;
            redrawCanvas();
          }
        } else {
          // group selected
          editor.groupSelected();
          redrawCanvas();
          updateInspector();
        }
        ev.preventDefault();
        return;
      }
      if (k === "d" && ev.ctrlKey) {
        // duplicate selected
        editor.duplicateSelection();
        redrawCanvas();
        updateInspector();
        ev.preventDefault();
        return;
      }
      if (k === "z" && ev.ctrlKey) {
        // undo
        editor.undo();
        redrawCanvas();
        updateInspector();
        ev.preventDefault();
        return;
      }
      if (k === "y" && ev.ctrlKey) {
        // redo
        editor.redo();
        redrawCanvas();
        updateInspector();
        ev.preventDefault();
        return;
      }
    });

    // layer list hookup
    // prefer floating layer list if present (floating panel added in editor.html)
    const floatingList = document.getElementById("floating-layer-list");
    const floatingSearch = document.getElementById("floating-layer-search");
    const staticLayerList = document.getElementById("layer-list");
    if (floatingList) {
      editor.setLayerListElement(floatingList);
      // hook search
      if (floatingSearch) {
        floatingSearch.addEventListener("input", () => {
          const v = floatingSearch.value || "";
          const sEl = document.getElementById("layer-search");
          if (sEl) sEl.value = v;
          window.updateLayerList();
        });
      }
      window.updateLayerList();
    } else if (staticLayerList) {
      editor.setLayerListElement(staticLayerList);
      window.updateLayerList();
    }

    // pipette and palette UI
    const pipBtn = document.getElementById("pipette-btn");
    const primaryEl = document.getElementById("primary-color");
    const secondaryEl = document.getElementById("secondary-color");
    const addToPaletteBtn = document.getElementById("add-to-palette");
    const paletteEl = document.getElementById("color-palette");
    const fillSwatch = document.getElementById("fill-swatch");
    const strokeSwatch = document.getElementById("stroke-swatch");
    const fillInputHidden = document.getElementById("fill-color");
    const strokeInputHidden = document.getElementById("stroke-color");

    // load palette from localStorage if present
    try {
      const saved = localStorage.getItem("p5_palette");
      if (saved) this.palette = JSON.parse(saved) || this.palette;
    } catch (e) {
      // ignore parse errors
    }
    // wire floating layers panel drag/close
    const fl = document.getElementById("floating-layers");
    const flHandle = document.getElementById("floating-layers-handle");
    const flClose = document.getElementById("floating-layers-close");
    const flToggle = document.getElementById("floating-layers-toggle");
    if (fl && flHandle) {
      // Robust drag: start on pointerdown, attach document-level move/up, require threshold before moving
      let startX = 0,
        startY = 0,
        startLeft = 0,
        startTop = 0,
        moved = false;
      const threshold = 6;
      let pointerId = null;

      function onPointerMove(e) {
        if (pointerId !== null && e.pointerId !== pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved) {
          if (Math.hypot(dx, dy) < threshold) return;
          moved = true;
        }
        fl.style.left = Math.max(8, startLeft + dx) + "px";
        fl.style.top = Math.max(8, startTop + dy) + "px";
      }

      function onPointerUp(e) {
        if (pointerId !== null && e.pointerId !== pointerId) return;
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        try {
          fl.releasePointerCapture(pointerId);
        } catch (err) {}
        pointerId = null;
        moved = false;
      }

      flHandle.addEventListener("pointerdown", (e) => {
        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        const rect = fl.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        moved = false;
        try {
          fl.setPointerCapture(pointerId);
        } catch (err) {}
        document.addEventListener("pointermove", onPointerMove);
        document.addEventListener("pointerup", onPointerUp);
      });
      // close/minimize
      if (flClose)
        flClose.addEventListener("click", () => {
          fl.style.display = "none";
        });
      if (flToggle) flToggle.addEventListener("click", () => {});
      if (flToggle)
        flToggle.addEventListener("click", () => {
          const c = document.getElementById("floating-layers-content");
          if (c) {
            c.style.display = c.style.display === "none" ? "block" : "none";
          }
        });
    }

    // Lasso tool wiring: ensure the button toggles lasso mode
    const lassoBtn = document.getElementById("tool-lasso");
    if (lassoBtn) {
      lassoBtn.addEventListener("click", () => {
        const prevSel = editor.selected.slice();
        editor.mode = editor.mode === "lasso" ? "select" : "lasso";
        editor.selected = prevSel;
        updateModeButtons();
        updateInspector();
        updateStatusBar();
        redrawCanvas();
      });
    }

    // create a floating micro-hint element for handles/tooltips (accessible)
    (function ensureToolHint() {
      if (document.getElementById("tool-hint")) return;
      const h = document.createElement("div");
      h.id = "tool-hint";
      h.style.position = "fixed";
      h.style.pointerEvents = "none";
      h.style.background = "rgba(0,0,0,0.75)";
      h.style.color = "#fff";
      h.style.padding = "4px 8px";
      h.style.borderRadius = "4px";
      h.style.fontSize = "12px";
      h.style.zIndex = 100000;
      h.style.display = "none";
      h.setAttribute("role", "status");
      h.setAttribute("aria-live", "polite");
      h.setAttribute("aria-atomic", "true");
      document.body.appendChild(h);
    })();

    // Wire Apply Scale button in inspector
    const applyScaleBtn = document.getElementById("apply-scale-btn");
    if (applyScaleBtn)
      applyScaleBtn.addEventListener("click", () => {
        editor.applyScaleToSelection();
        updateInspector();
        redrawCanvas();
      });
    const applyRotateBtn = document.getElementById("apply-rotate-btn");
    if (applyRotateBtn)
      applyRotateBtn.addEventListener("click", () => {
        editor.applyRotateToSelection();
        updateInspector();
        redrawCanvas();
      });
    // Boolean ops
    const boolUnion = document.getElementById("bool-union");
    const boolDiff = document.getElementById("bool-diff");
    const boolInter = document.getElementById("bool-intersect");
    const boolXor = document.getElementById("bool-xor");
    if (boolUnion)
      boolUnion.addEventListener("click", () => {
        editor.performBooleanOp("union");
        redrawCanvas();
        updateInspector();
      });
    if (boolDiff)
      boolDiff.addEventListener("click", () => {
        editor.performBooleanOp("diff");
        redrawCanvas();
        updateInspector();
      });
    if (boolInter)
      boolInter.addEventListener("click", () => {
        editor.performBooleanOp("intersect");
        redrawCanvas();
        updateInspector();
      });
    if (boolXor)
      boolXor.addEventListener("click", () => {
        editor.performBooleanOp("xor");
        redrawCanvas();
        updateInspector();
      });

    // Vertex edit helpers
    const addV = document.getElementById("add-vertex-btn");
    const delV = document.getElementById("delete-vertex-btn");
    const addEdgeV = document.getElementById("add-vertex-edge-btn");
    const toggleSmooth = document.getElementById("toggle-smooth-btn");
    const convertTextPath = document.getElementById("convert-text-path");
    const convertImageShape = document.getElementById("convert-image-shape");
    if (addV)
      addV.addEventListener("click", () => {
        // add vertex at center of selected shape
        if (!editor.selected || editor.selected.length !== 1) return;
        const s = editor.selected[0];
        const b = s._computeBounds ? s._computeBounds() : null;
        if (!b) return;
        if (!s.vertices) s.vertices = [];
        s.vertices.push({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    if (delV)
      delV.addEventListener("click", () => {
        if (!editor.selected || editor.selected.length !== 1) return;
        const s = editor.selected[0];
        if (!s.vertices || s.vertices.length <= 3) return;
        // if a specific vertex is selected, delete that one; otherwise delete last
        if (editor._selectedVertex && editor._selectedVertex.shape === s) {
          const idx = editor._selectedVertex.index;
          if (idx >= 0 && idx < s.vertices.length) {
            s.vertices.splice(idx, 1);
            editor._selectedVertex = null;
          }
        } else {
          s.vertices.pop();
        }
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    if (addEdgeV)
      addEdgeV.addEventListener("click", () => {
        if (!editor.selected || editor.selected.length !== 1) return;
        const s = editor.selected[0];
        // if in vertex mode, and a nearest edge is highlighted, double-click insertion works - fallback: insert midpoint of first edge
        if (!s.vertices || s.vertices.length < 2) return;
        const a = s.vertices[0];
        const b = s.vertices[1];
        s.vertices.splice(1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    if (toggleSmooth)
      toggleSmooth.addEventListener("click", () => {
        if (!editor.selected || editor.selected.length !== 1) return;
        const s = editor.selected[0];
        s._smooth = !s._smooth;
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    if (convertTextPath)
      convertTextPath.addEventListener("click", () => {
        if (!editor.selected || editor.selected.length !== 1) return;
        const s = editor.selected[0];
        // convert simple text command into path approximation using p5.textToPoints if available
        if (
          s.commands &&
          s.commands.length === 1 &&
          s.commands[0].type === "text" &&
          editor.p
        ) {
          const c = s.commands[0];
          const fontSize = c.size || 32;
          try {
            if (typeof editor.p.textToPoints === "function") {
              const pts = editor.p.textToPoints(
                c.content || "",
                c.x,
                c.y,
                fontSize,
                { sampleFactor: 0.2 }
              );
              if (pts && pts.length) {
                s.vertices = pts.map((p) => ({ x: p.x, y: p.y }));
                s.commands = [];
                editor.pushHistory();
                redrawCanvas();
                updateInspector();
                return;
              }
            }
            // fallback: approximate as a rectangle based on textWidth/ascent/descent
            try {
              // attempt to use p5 text metrics for better bounds
              const p = editor.p;
              const prevSize = p._renderer && p._renderer._textSize;
              // set textSize temporarily
              if (typeof p.textSize === "function") p.textSize(fontSize);
              const tw =
                typeof p.textWidth === "function"
                  ? p.textWidth(c.content || "")
                  : (c.content || "").length * (fontSize * 0.6);
              const ta =
                typeof p.textAscent === "function"
                  ? p.textAscent()
                  : fontSize * 0.8;
              const td =
                typeof p.textDescent === "function"
                  ? p.textDescent()
                  : fontSize * 0.2;
              const w =
                tw ||
                Math.max(
                  8,
                  fontSize * (c.content ? c.content.length * 0.6 : 1)
                );
              const h = ta + td || fontSize;
              // rectangle centered at c.x,c.y (p5 draws text baseline at y; approximate as center)
              const rectX = c.x - w / 2;
              const rectY = c.y - h / 2;
              s.vertices = [
                { x: rectX, y: rectY },
                { x: rectX + w, y: rectY },
                { x: rectX + w, y: rectY + h },
                { x: rectX, y: rectY + h },
              ];
              s.commands = [];
              // restore textSize if possible (best-effort)
              if (typeof p.textSize === "function" && prevSize)
                p.textSize(prevSize);
              editor.pushHistory();
              redrawCanvas();
              updateInspector();
              return;
            } catch (ee) {
              // final fallback: simple rectangle of fixed size
              const w = fontSize * Math.max(1, (c.content || "").length * 0.5);
              const h = fontSize;
              const rectX = c.x - w / 2;
              const rectY = c.y - h / 2;
              s.vertices = [
                { x: rectX, y: rectY },
                { x: rectX + w, y: rectY },
                { x: rectX + w, y: rectY + h },
                { x: rectX, y: rectY + h },
              ];
              s.commands = [];
              editor.pushHistory();
              redrawCanvas();
              updateInspector();
              return;
            }
          } catch (e) {
            // if anything goes wrong, fallback to simple rectangle conversion
            try {
              const fontSize = c.size || 32;
              const w = fontSize * Math.max(1, (c.content || "").length * 0.5);
              const h = fontSize;
              const rectX = c.x - w / 2;
              const rectY = c.y - h / 2;
              s.vertices = [
                { x: rectX, y: rectY },
                { x: rectX + w, y: rectY },
                { x: rectX + w, y: rectY + h },
                { x: rectX, y: rectY + h },
              ];
              s.commands = [];
              editor.pushHistory();
              redrawCanvas();
              updateInspector();
            } catch (ee) {
              // give up silently
            }
          }
        }
      });
    if (convertImageShape)
      convertImageShape.addEventListener("click", () => {
        if (!editor.selected || editor.selected.length !== 1) return;
        const s = editor.selected[0];
        // convert image command to a rect-shaped polygon
        if (
          s.commands &&
          s.commands.length === 1 &&
          s.commands[0].type === "image"
        ) {
          const c = s.commands[0];
          const w = c.w || 100;
          const h = c.h || 100;
          s.vertices = [
            { x: c.x - w / 2, y: c.y - h / 2 },
            { x: c.x + w / 2, y: c.y - h / 2 },
            { x: c.x + w / 2, y: c.y + h / 2 },
            { x: c.x - w / 2, y: c.y + h / 2 },
          ];
          s.commands = [];
          editor.pushHistory();
          redrawCanvas();
          updateInspector();
        }
      });
    // helper: try to normalize a CSS color (hex, rgb(), rgba()) to #rrggbb
    function normalizeToHex(raw) {
      if (!raw) return null;
      const byHex = colorToHex(raw);
      if (byHex) return byHex.toLowerCase();
      // try to parse rgb(a) explicit patterns
      const m = String(raw).match(/rgba?\s*\(([^)]+)\)/i);
      if (m) {
        const parts = m[1].split(",").map((s) => parseFloat(s));
        if (parts.length >= 3) {
          const r = Math.round(parts[0]);
          const g = Math.round(parts[1]);
          const b = Math.round(parts[2]);
          return (
            "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")
          ).toLowerCase();
        }
      }
      return null;
    }
    function renderPalette() {
      if (!paletteEl) return;
      paletteEl.innerHTML = "";
      // ensure a default selected target
      if (!editor._selectedColorTarget)
        editor._selectedColorTarget = editor._selectedColorTarget || "primary";
      editor.palette.forEach((c, idx) => {
        const sw = document.createElement("div");
        sw.style.width = "28px";
        sw.style.height = "28px";
        sw.style.border = "1px solid #ddd";
        sw.style.background = c;
        sw.style.cursor = "pointer";
        sw.title = c;
        sw.style.position = "relative";
        sw.style.boxSizing = "border-box";
        sw.style.display = "inline-block";
        // add remove overlay
        const rem = document.createElement("button");
        rem.textContent = "×";
        rem.title = "Remove";
        rem.style.position = "absolute";
        rem.style.right = "-6px";
        rem.style.top = "-6px";
        rem.style.width = "16px";
        rem.style.height = "16px";
        rem.style.padding = "0";
        rem.style.border = "none";
        rem.style.background = "rgba(0,0,0,0.5)";
        rem.style.color = "white";
        rem.style.borderRadius = "8px";
        rem.style.cursor = "pointer";
        rem.style.fontSize = "12px";
        rem.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (!confirm(`Remove color ${c} from palette?`)) return;
          editor.palette.splice(idx, 1);
          try {
            localStorage.setItem("p5_palette", JSON.stringify(editor.palette));
          } catch (e) {}
          renderPalette();
        });
        sw.appendChild(rem);
        sw.addEventListener("click", (e) => {
          // select this palette swatch as current selected color target (don't auto-apply to primary)
          editor._selectedColorTarget = `palette-${idx}`;
          editor._pipetteTarget = `palette-${idx}`;
          // clear outlines on all swatches and color targets
          if (paletteEl)
            Array.from(paletteEl.children).forEach(
              (ch) => (ch.style.outline = "")
            );
          if (primaryEl) primaryEl.style.outline = "";
          if (secondaryEl) secondaryEl.style.outline = "";
          if (fillSwatch) fillSwatch.style.outline = "";
          if (strokeSwatch) strokeSwatch.style.outline = "";
          sw.style.outline = "3px solid rgba(0,0,0,0.08)";
          // if shapes are selected, apply this palette color to their fill and record history
          try {
            const hex = normalizeToHex(c) || colorToHex(c) || c;
            console.log("palette swatch click", idx, {
              color: c,
              hex,
              selected: (editor.selected || []).length,
            });
            if (!editor.selected || !editor.selected.length) {
              // helpful hint for debugging: no shapes selected
              showNotification(
                "No shapes selected — palette swatch selected only",
                "error"
              );
            } else {
              const opacityEl = document.getElementById("fill-opacity");
              const opacity = opacityEl
                ? opacityEl.value === ""
                  ? 100
                  : parseFloat(opacityEl.value)
                : 100;
              editor.selected.forEach((s) => {
                s.fill = hexToRgbA(hex, opacity);
              });
              editor.pushHistory();
              redrawCanvas();
              updateInspector();
            }
          } catch (err) {
            console.error("Palette swatch apply error", err);
          }
          // focus for keyboard interaction
          sw.focus();
          try {
            localStorage.setItem("p5_selected_target", `palette-${idx}`);
          } catch (e) {}
        });
        // keyboard: allow Delete/Backspace to remove focused swatch
        sw.tabIndex = 0;
        sw.addEventListener("keydown", (ke) => {
          if (ke.key === "Delete" || ke.key === "Backspace") {
            ke.preventDefault();
            if (!confirm(`Remove color ${c} from palette?`)) return;
            editor.palette.splice(idx, 1);
            try {
              localStorage.setItem(
                "p5_palette",
                JSON.stringify(editor.palette)
              );
            } catch (e) {}
            renderPalette();
          }
        });
        // allow right-click to remove a palette color
        sw.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          // contextmenu also removes
          if (!confirm(`Remove color ${c} from palette?`)) return;
          editor.palette.splice(idx, 1);
          try {
            localStorage.setItem("p5_palette", JSON.stringify(editor.palette));
          } catch (e) {}
          renderPalette();
        });
        sw.addEventListener("dblclick", (e) => {
          // double-click: open a temporary color input to edit this palette color
          const tmp = document.createElement("input");
          tmp.type = "color";
          tmp.value = colorToHex(c) || "#000000";
          tmp.style.position = "fixed";
          tmp.style.left = "-9999px";
          document.body.appendChild(tmp);
          tmp.addEventListener("input", (ev) => {
            const newc = ev.target.value;
            editor.palette[idx] = newc;
            renderPalette();
            // if primary matches old, update primary swatch
            const pri = document.getElementById("primary-color");
            if (pri && pri.style.background === c) pri.style.background = newc;
            try {
              localStorage.setItem(
                "p5_palette",
                JSON.stringify(editor.palette)
              );
            } catch (e) {}
          });
          tmp.addEventListener("change", () => document.body.removeChild(tmp));
          tmp.click();
        });
        paletteEl.appendChild(sw);
      });
    }
    if (pipBtn)
      pipBtn.addEventListener("click", () => {
        // entering pipette mode: keep last selected target, default to primary
        if (!editor._pipetteTarget)
          editor._pipetteTarget = editor._selectedColorTarget || "primary";
        editor.pipetteMode = !editor.pipetteMode;
        pipBtn.style.fontWeight = editor.pipetteMode ? "700" : "400";
      });
    if (addToPaletteBtn)
      addToPaletteBtn.addEventListener("click", () => {
        // prefer the currently selected color target (primary/secondary/fill/stroke/palette-N)
        let raw = null;
        if (editor._selectedColorTarget) {
          const t = editor._selectedColorTarget;
          if (t === "primary" && primaryEl)
            raw = getComputedStyle(primaryEl).backgroundColor;
          else if (t === "secondary" && secondaryEl)
            raw = getComputedStyle(secondaryEl).backgroundColor;
          else if (t === "fill" && fillSwatch)
            raw = getComputedStyle(fillSwatch).backgroundColor;
          else if (t === "stroke" && strokeSwatch)
            raw = getComputedStyle(strokeSwatch).backgroundColor;
          else if (t.startsWith("palette-") && paletteEl) {
            const idx = parseInt(t.split("-")[1]);
            if (!isNaN(idx) && paletteEl.children[idx])
              raw = getComputedStyle(paletteEl.children[idx]).backgroundColor;
          }
        }
        // fallback to fill/primary/secondary
        try {
          if (!raw && fillSwatch)
            raw = getComputedStyle(fillSwatch).backgroundColor;
          if (!raw && primaryEl)
            raw = getComputedStyle(primaryEl).backgroundColor;
          if (!raw && secondaryEl)
            raw = getComputedStyle(secondaryEl).backgroundColor;
        } catch (e) {
          if (
            !raw &&
            fillSwatch &&
            fillSwatch.style &&
            fillSwatch.style.background
          )
            raw = fillSwatch.style.background;
          else if (
            !raw &&
            primaryEl &&
            primaryEl.style &&
            primaryEl.style.background
          )
            raw = primaryEl.style.background;
          else if (
            !raw &&
            secondaryEl &&
            secondaryEl.style &&
            secondaryEl.style.background
          )
            raw = secondaryEl.style.background;
        }
        const c = normalizeToHex(raw) || "#000000";
        if (!editor.palette.includes(c)) editor.palette.push(c);
        renderPalette();
        try {
          localStorage.setItem("p5_palette", JSON.stringify(editor.palette));
        } catch (e) {}
      });
    renderPalette();
    // palette apply buttons wiring
    const applyPri = document.getElementById("apply-palette-primary");
    const applySec = document.getElementById("apply-palette-secondary");
    const applySel = document.getElementById("apply-palette-selection");
    function currentSelectedPaletteColor() {
      if (!editor._selectedColorTarget) return null;
      if (!editor._selectedColorTarget.startsWith("palette-")) return null;
      const idx = parseInt(editor._selectedColorTarget.split("-")[1]);
      if (isNaN(idx)) return null;
      return editor.palette[idx] || null;
    }
    if (applyPri)
      applyPri.addEventListener("click", () => {
        const c = currentSelectedPaletteColor();
        if (!c) return;
        try {
          if (primaryEl) primaryEl.style.background = c;
          const fillInput = document.getElementById("fill-color");
          if (fillInput) fillInput.value = c;
          try {
            if (fillSwatch) fillSwatch.style.background = c;
          } catch (e) {}
        } catch (e) {}
        // if shapes selected, apply to selection
        try {
          if (editor.selected && editor.selected.length) {
            const opacity = document.getElementById("fill-opacity")
              ? document.getElementById("fill-opacity").value
              : 100;
            editor.selected.forEach((s) => {
              s.fill = hexToRgbA(c, opacity || 100);
            });
            editor.pushHistory();
            redrawCanvas();
            updateInspector();
          }
        } catch (err) {}
        try {
          localStorage.setItem("p5_selected_target", "primary");
        } catch (e) {}
      });
    if (applySec)
      applySec.addEventListener("click", () => {
        const c = currentSelectedPaletteColor();
        if (!c) return;
        try {
          if (secondaryEl) secondaryEl.style.background = c;
          const strokeInput = document.getElementById("stroke-color");
          if (strokeInput) strokeInput.value = c;
          try {
            if (strokeSwatch) strokeSwatch.style.background = c;
          } catch (e) {}
        } catch (e) {}
        // if shapes selected, apply stroke to selection
        try {
          if (editor.selected && editor.selected.length) {
            const opacity = document.getElementById("stroke-opacity")
              ? document.getElementById("stroke-opacity").value
              : 100;
            editor.selected.forEach((s) => {
              s.stroke = hexToRgbA(c, opacity || 100);
              if (!s.strokeWeight || s.strokeWeight === 0) {
                const swEl = document.getElementById("stroke-weight");
                s.strokeWeight = swEl ? parseFloat(swEl.value) || 1 : 1;
              }
            });
            editor.pushHistory();
            redrawCanvas();
            updateInspector();
          }
        } catch (err) {}
        try {
          localStorage.setItem("p5_selected_target", "secondary");
        } catch (e) {}
      });
    if (applySel)
      applySel.addEventListener("click", () => {
        const c = currentSelectedPaletteColor();
        if (!c) return;
        const opacity = document.getElementById("fill-opacity")
          ? document.getElementById("fill-opacity").value
          : 100;
        editor.selected.forEach((s) => {
          s.fill = hexToRgbA(c, opacity || 100);
        });
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    // initialize visible swatches from elements/values
    if (primaryEl && primaryEl.style.background) {
      // leave as-is
    }
    if (secondaryEl && secondaryEl.style.background) {
      // leave as-is
    }
    if (fillSwatch) {
      const fv = document.getElementById("fill-color");
      if (fv && fv.value) fillSwatch.style.background = fv.value;
    }
    if (strokeSwatch) {
      const sv = document.getElementById("stroke-color");
      if (sv && sv.value) strokeSwatch.style.background = sv.value;
    }
    // if a palette entry was previously selected, highlight it
    if (
      editor._selectedColorTarget &&
      editor._selectedColorTarget.startsWith("palette-") &&
      paletteEl
    ) {
      const idx = parseInt(editor._selectedColorTarget.split("-")[1]);
      if (!isNaN(idx) && paletteEl.children[idx])
        paletteEl.children[idx].style.outline = "3px solid rgba(0,0,0,0.08)";
    } else if (editor._selectedColorTarget === "primary" && primaryEl) {
      primaryEl.style.outline = "3px solid rgba(0,0,0,0.08)";
    } else if (editor._selectedColorTarget === "secondary" && secondaryEl) {
      secondaryEl.style.outline = "3px solid rgba(0,0,0,0.08)";
    } else if (editor._selectedColorTarget === "fill" && fillSwatch) {
      fillSwatch.style.outline = "3px solid rgba(0,0,0,0.08)";
    } else if (editor._selectedColorTarget === "stroke" && strokeSwatch) {
      strokeSwatch.style.outline = "3px solid rgba(0,0,0,0.08)";
    }
    // update target label
    const targetLabel = document.getElementById("color-target-label");
    if (targetLabel)
      targetLabel.textContent = `Target: ${
        editor._selectedColorTarget || "primary"
      }`;
    // swatch single-click selects swatch; double-click opens color editor
    if (primaryEl) {
      primaryEl.addEventListener("click", () => {
        // select primary as the current color target
        editor._selectedColorTarget = "primary";
        editor._pipetteTarget = "primary";
        // clear outlines everywhere
        if (paletteEl)
          Array.from(paletteEl.children).forEach(
            (ch) => (ch.style.outline = "")
          );
        if (fillSwatch) fillSwatch.style.outline = "";
        if (strokeSwatch) strokeSwatch.style.outline = "";
        if (secondaryEl) secondaryEl.style.outline = "";
        primaryEl.style.outline = "3px solid rgba(0,0,0,0.08)";
        const targetLabel = document.getElementById("color-target-label");
        if (targetLabel) targetLabel.textContent = "Target: primary";
        try {
          localStorage.setItem("p5_selected_target", "primary");
        } catch (e) {}
        // if shapes are selected, apply primary color as fill to selection and push history
        try {
          let raw = null;
          try {
            raw = getComputedStyle(primaryEl).backgroundColor;
          } catch (e) {
            raw = primaryEl.style && primaryEl.style.background;
          }
          const hex = normalizeToHex(raw) || colorToHex(raw) || raw;
          console.log("primary click", {
            raw,
            hex,
            selected: (editor.selected || []).length,
          });
          // update visible primary/fill inputs and swatches so UI reflects change
          try {
            if (primaryEl) primaryEl.style.background = hex;
            const fillInput = document.getElementById("fill-color");
            if (fillInput) fillInput.value = hex;
            try {
              if (fillSwatch) fillSwatch.style.background = hex;
            } catch (e) {}
          } catch (e) {}
          if (!editor.selected || !editor.selected.length) {
            showNotification(
              "No shapes selected — primary swatch set as target only",
              "error"
            );
          } else {
            const opacityEl = document.getElementById("fill-opacity");
            const opacity = opacityEl
              ? opacityEl.value === ""
                ? 100
                : parseFloat(opacityEl.value)
              : 100;
            editor.selected.forEach((s) => {
              s.fill = hexToRgbA(hex, opacity);
            });
            editor.pushHistory();
            redrawCanvas();
            updateInspector();
          }
        } catch (err) {
          console.error("Primary swatch apply error", err);
        }
      });
      primaryEl.addEventListener("dblclick", () => {
        // open a temporary color input to edit primary swatch
        const tmp = document.createElement("input");
        tmp.type = "color";
        tmp.value = colorToHex(primaryEl.style.background) || "#000000";
        tmp.style.position = "fixed";
        tmp.style.left = "-9999px";
        document.body.appendChild(tmp);
        tmp.addEventListener("input", (ev) => {
          primaryEl.style.background = ev.target.value;
        });
        tmp.addEventListener("change", () => document.body.removeChild(tmp));
        tmp.click();
      });
    }
    if (secondaryEl) {
      secondaryEl.addEventListener("click", () => {
        editor._selectedColorTarget = "secondary";
        editor._pipetteTarget = "secondary";
        if (paletteEl)
          Array.from(paletteEl.children).forEach(
            (ch) => (ch.style.outline = "")
          );
        if (primaryEl) primaryEl.style.outline = "";
        if (fillSwatch) fillSwatch.style.outline = "";
        if (strokeSwatch) strokeSwatch.style.outline = "";
        secondaryEl.style.outline = "3px solid rgba(0,0,0,0.08)";
        const targetLabel = document.getElementById("color-target-label");
        if (targetLabel) targetLabel.textContent = "Target: secondary";
        try {
          localStorage.setItem("p5_selected_target", "secondary");
        } catch (e) {}
        // if shapes are selected, apply secondary color as stroke to selection and push history
        try {
          let raw = null;
          try {
            raw = getComputedStyle(secondaryEl).backgroundColor;
          } catch (e) {
            raw = secondaryEl.style && secondaryEl.style.background;
          }
          const hex = normalizeToHex(raw) || colorToHex(raw) || raw;
          console.log("secondary click", {
            raw,
            hex,
            selected: (editor.selected || []).length,
          });
          // update visible secondary/stroke inputs and swatches so UI reflects change
          try {
            if (secondaryEl) secondaryEl.style.background = hex;
            const strokeInput = document.getElementById("stroke-color");
            if (strokeInput) strokeInput.value = hex;
            try {
              if (strokeSwatch) strokeSwatch.style.background = hex;
            } catch (e) {}
          } catch (e) {}
          if (!editor.selected || !editor.selected.length) {
            showNotification(
              "No shapes selected — secondary swatch set as target only",
              "error"
            );
          } else {
            const opacityEl = document.getElementById("stroke-opacity");
            const opacity = opacityEl
              ? opacityEl.value === ""
                ? 100
                : parseFloat(opacityEl.value)
              : 100;
            editor.selected.forEach((s) => {
              s.stroke = hexToRgbA(hex, opacity);
              // ensure a visible stroke by using stroke-weight input when missing
              if (!s.strokeWeight || s.strokeWeight === 0) {
                const swEl = document.getElementById("stroke-weight");
                s.strokeWeight = swEl ? parseFloat(swEl.value) || 1 : 1;
              }
            });
            editor.pushHistory();
            redrawCanvas();
            updateInspector();
          }
        } catch (err) {
          console.error("Secondary swatch apply error", err);
        }
      });
      secondaryEl.addEventListener("dblclick", () => {
        const tmp = document.createElement("input");
        tmp.type = "color";
        tmp.value = colorToHex(secondaryEl.style.background) || "#000000";
        tmp.style.position = "fixed";
        tmp.style.left = "-9999px";
        document.body.appendChild(tmp);
        tmp.addEventListener("input", (ev) => {
          secondaryEl.style.background = ev.target.value;
        });
        tmp.addEventListener("change", () => document.body.removeChild(tmp));
        tmp.click();
      });
    }
    // fill/stroke swatch handlers
    if (fillSwatch) {
      fillSwatch.addEventListener("click", () => {
        editor._selectedColorTarget = "fill";
        editor._pipetteTarget = "fill";
        // clear palette outlines
        if (paletteEl)
          Array.from(paletteEl.children).forEach(
            (ch) => (ch.style.outline = "")
          );
        if (primaryEl) primaryEl.style.outline = "";
        if (secondaryEl) secondaryEl.style.outline = "";
        fillSwatch.style.outline = "3px solid rgba(0,0,0,0.08)";
        const targetLabel = document.getElementById("color-target-label");
        if (targetLabel) targetLabel.textContent = "Target: fill";
        try {
          localStorage.setItem("p5_selected_target", "fill");
        } catch (e) {}
      });
      fillSwatch.addEventListener("dblclick", () => {
        if (!fillInputHidden) return;
        fillInputHidden.click();
      });
    }
    if (strokeSwatch) {
      strokeSwatch.addEventListener("click", () => {
        editor._selectedColorTarget = "stroke";
        editor._pipetteTarget = "stroke";
        if (paletteEl)
          Array.from(paletteEl.children).forEach(
            (ch) => (ch.style.outline = "")
          );
        if (primaryEl) primaryEl.style.outline = "";
        if (secondaryEl) secondaryEl.style.outline = "";
        strokeSwatch.style.outline = "3px solid rgba(0,0,0,0.08)";
        const targetLabel = document.getElementById("color-target-label");
        if (targetLabel) targetLabel.textContent = "Target: stroke";
        try {
          localStorage.setItem("p5_selected_target", "stroke");
        } catch (e) {}
      });
      strokeSwatch.addEventListener("dblclick", () => {
        if (!strokeInputHidden) return;
        strokeInputHidden.click();
      });
    }
    // Round Up button
    const roundUpBtn = document.getElementById("round-up-btn");
    if (roundUpBtn) {
      roundUpBtn.addEventListener("click", (ev) => {
        const select = document.getElementById("round-mode-select");
        let mode = "int";
        // two selects exist now: coords and transform
        const coords = document.getElementById("round-coords-select");
        const trans = document.getElementById("round-transform-select");
        const coordMode = coords && coords.value ? coords.value : "int";
        const transMode = trans && trans.value ? trans.value : "0.1";
        // run round for coords/vertices first
        editor.selected.forEach((s) => {
          // round coords & vertices using coordMode
          const makeRounder = (m) => {
            return (v) => {
              if (typeof v !== "number") return v;
              if (m === "5") return Math.round(v / 5) * 5;
              if (m === "0.1") return Math.round(v * 10) / 10;
              if (m === "0.01") return Math.round(v * 100) / 100;
              return Math.round(v);
            };
          };
          const rcoords = makeRounder(coordMode);
          if (s.x !== undefined) s.x = rcoords(s.x);
          if (s.y !== undefined) s.y = rcoords(s.y);
          if (s.vertices && Array.isArray(s.vertices)) {
            s.vertices.forEach((v) => {
              if (v.x !== undefined) v.x = rcoords(v.x);
              if (v.y !== undefined) v.y = rcoords(v.y);
            });
          }
        });
        // then round transform props using transMode, special-case scale
        editor.selected.forEach((s) => {
          const makeRounder = (m) => {
            return (v) => {
              if (typeof v !== "number") return v;
              if (m === "5") return Math.round(v / 5) * 5;
              if (m === "0.1") return Math.round(v * 10) / 10;
              if (m === "0.01") return Math.round(v * 100) / 100;
              return Math.round(v);
            };
          };
          const rt = makeRounder(transMode);
          if (s.rotation !== undefined) s.rotation = rt(s.rotation);
          if (s.scale !== undefined) {
            const sc = s.scale;
            if (transMode === "0.01" || transMode === "0.1") s.scale = rt(sc);
            else {
              const abs = Math.abs(sc);
              if (abs < 0.2) s.scale = Math.round(sc * 100) / 100;
              else if (abs < 2) s.scale = Math.round(sc * 10) / 10;
              else s.scale = rt(sc);
            }
          }
        });
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    }
    // when hidden color inputs change, apply to swatches and selected shapes
    if (fillInputHidden) {
      fillInputHidden.addEventListener("input", (e) => {
        fillSwatch.style.background = e.target.value;
        // apply to selected shapes
        const opacity = document.getElementById("fill-opacity").value || 100;
        editor.selected.forEach((s) => {
          s.fill = hexToRgbA(e.target.value, opacity);
        });
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    }
    // inspector text/image live edits
    const inspectorText = document.getElementById("inspector-text-input");
    const inspectorImageUrl = document.getElementById("inspector-image-url");
    let _textEditTimer = null;
    if (inspectorText) {
      inspectorText.addEventListener("input", (ev) => {
        if (!editor.selected || editor.selected.length !== 1) return;
        const s = editor.selected[0];
        if (
          !s.commands ||
          s.commands.length !== 1 ||
          s.commands[0].type !== "text"
        )
          return;
        s.commands[0].content = ev.target.value;
        // live redraw but debounce history push
        redrawCanvas();
        if (_textEditTimer) clearTimeout(_textEditTimer);
        _textEditTimer = setTimeout(() => {
          editor.pushHistory();
          updateInspector();
        }, 500);
      });
    }
    if (inspectorImageUrl) {
      inspectorImageUrl.addEventListener("change", (ev) => {
        if (!editor.selected || editor.selected.length !== 1) return;
        const s = editor.selected[0];
        if (
          !s.commands ||
          s.commands.length !== 1 ||
          s.commands[0].type !== "image"
        )
          return;
        const c = s.commands[0];
        c.src = ev.target.value;
        editor._loadImageForCommand(c);
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    }
    // Wire show-grid checkbox
    const showGridEl = document.getElementById("show-grid");
    if (showGridEl) {
      showGridEl.addEventListener("change", () => {
        editor.gridVisible = showGridEl.checked;
        redrawCanvas();
      });
      // initialize gridVisible from checkbox
      editor.gridVisible = showGridEl.checked;
    }
    if (strokeInputHidden) {
      strokeInputHidden.addEventListener("input", (e) => {
        strokeSwatch.style.background = e.target.value;
        const opacity = document.getElementById("stroke-opacity").value || 100;
        editor.selected.forEach((s) => {
          s.stroke = hexToRgbA(e.target.value, opacity);
        });
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    }
    document.getElementById("ungroup-btn").addEventListener("click", () => {
      if (editor.selected[0] && editor.selected[0].type === "group") {
        editor.ungroup(editor.selected[0]);
        redrawCanvas();
        updateInspector();
      }
    });
    const dupBtn = document.getElementById("duplicate-btn");
    if (dupBtn)
      dupBtn.addEventListener("click", () => {
        editor.duplicateSelection();
        redrawCanvas();
        updateInspector();
      });
    document.getElementById("delete-btn").addEventListener("click", () => {
      editor.selected.forEach((s) => editor.removeShapeById(s.id));
      editor.clearSelection();
      redrawCanvas();
      updateInspector();
    });

    // Transform panel wiring
    const txEl = document.getElementById("transform-x");
    const tyEl = document.getElementById("transform-y");
    const trotEl = document.getElementById("transform-rot");
    const tscaleEl = document.getElementById("transform-scale");
    const snapToggle = document.getElementById("snap-to-grid");
    function updateTransformInputs() {
      if (editor.selected.length === 1) {
        const s = editor.selected[0];
        if (txEl) txEl.value = s.x || 0;
        if (tyEl) tyEl.value = s.y || 0;
        if (trotEl) trotEl.value = s.rotation || 0;
        if (tscaleEl) tscaleEl.value = s.scale !== undefined ? s.scale : 1;
      }
    }
    // apply inputs to selected (single) shape
    function applyTransformInputs() {
      if (editor.selected.length === 1) {
        const s = editor.selected[0];
        if (txEl) s.x = parseFloat(txEl.value) || 0;
        if (tyEl) s.y = parseFloat(tyEl.value) || 0;
        if (trotEl) s.rotation = parseFloat(trotEl.value) || 0;
        if (tscaleEl) s.scale = parseFloat(tscaleEl.value) || 1;
        // snap if enabled
        const snapEl = document.getElementById("snap-to-grid");
        const gridEl = document.getElementById("grid-size");
        if (snapEl && snapEl.checked && gridEl) {
          const gs = parseInt(gridEl.value) || 10;
          s.x = Math.round(s.x / gs) * gs;
          s.y = Math.round(s.y / gs) * gs;
        }
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      }
    }
    if (txEl) txEl.addEventListener("change", applyTransformInputs);
    if (tyEl) tyEl.addEventListener("change", applyTransformInputs);
    if (trotEl) trotEl.addEventListener("change", applyTransformInputs);
    if (tscaleEl) tscaleEl.addEventListener("change", applyTransformInputs);

    function nudge(dx, dy, multiplier = 1) {
      const step = multiplier === 10 ? 10 : 1;
      editor.selected.forEach((s) => {
        s.x = (s.x || 0) + dx * step;
        s.y = (s.y || 0) + dy * step;
      });
      // history coalescing handled by caller (buttons will push immediately; keyboard uses startCoalesce)
      updateTransformInputs();
      redrawCanvas();
      updateInspector();
    }
    const nUp = document.getElementById("nudge-up");
    const nLeft = document.getElementById("nudge-left");
    const nRight = document.getElementById("nudge-right");
    const nDown = document.getElementById("nudge-down");
    const n10 = document.getElementById("nudge-10");
    if (nUp)
      nUp.addEventListener("click", (e) => {
        nudge(0, -1, e.shiftKey ? 10 : 1);
        editor.pushHistory();
      });
    if (nLeft)
      nLeft.addEventListener("click", (e) => {
        nudge(-1, 0, e.shiftKey ? 10 : 1);
        editor.pushHistory();
      });
    if (nRight)
      nRight.addEventListener("click", (e) => {
        nudge(1, 0, e.shiftKey ? 10 : 1);
        editor.pushHistory();
      });
    if (nDown)
      nDown.addEventListener("click", (e) => {
        nudge(0, 1, e.shiftKey ? 10 : 1);
        editor.pushHistory();
      });
    if (n10)
      n10.addEventListener("click", () => {
        editor.selected.forEach((s) => {
          s.x = (s.x || 0) + 10;
        });
        editor.pushHistory();
      });
    // keyboard arrow nudges: move selected shape or vertex
    window.addEventListener("keydown", (ev) => {
      if (!editor) return;
      const step = ev.shiftKey ? 10 : 1;
      if (
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)
      ) {
        // when vertex drag active, move that vertex
        if (editor.vertexDrag) {
          const s = editor.vertexDrag.shape;
          const i = editor.vertexDrag.index;
          if (s && s.vertices && s.vertices[i]) {
            // start coalescing for repeated key presses
            editor.startCoalesce();
            if (ev.key === "ArrowUp") s.vertices[i].y -= step;
            if (ev.key === "ArrowDown") s.vertices[i].y += step;
            if (ev.key === "ArrowLeft") s.vertices[i].x -= step;
            if (ev.key === "ArrowRight") s.vertices[i].x += step;
            // timer will finish coalesce and push final snapshot
            redrawCanvas();
            updateInspector();
            ev.preventDefault();
          }
          return;
        }
        // otherwise move selected shapes
        if (editor.selected.length) {
          // coalesce a sequence of key presses into a single undo entry
          editor.startCoalesce();
          if (ev.key === "ArrowUp") nudge(0, -1, ev.shiftKey ? 10 : 1);
          if (ev.key === "ArrowDown") nudge(0, 1, ev.shiftKey ? 10 : 1);
          if (ev.key === "ArrowLeft") nudge(-1, 0, ev.shiftKey ? 10 : 1);
          if (ev.key === "ArrowRight") nudge(1, 0, ev.shiftKey ? 10 : 1);
          // redraw done in nudge
          ev.preventDefault();
        }
      }
      // delete selected vertex with Delete or Backspace
      if (
        (ev.key === "Delete" || ev.key === "Backspace") &&
        editor._selectedVertex
      ) {
        const sv = editor._selectedVertex;
        const s = sv.shape;
        const idx = sv.index;
        if (s && s.vertices && s.vertices.length > 3) {
          s.vertices.splice(idx, 1);
          editor._selectedVertex = null;
          editor.pushHistory();
          redrawCanvas();
          updateInspector();
        }
        ev.preventDefault();
        return;
      }
    });
    // update when selection changes
    window.updateInspector = function () {
      // override to also update transform inputs
      // original updateInspector is defined later; call it if exists
      try {
        if (typeof window.__old_updateInspector === "function")
          window.__old_updateInspector();
      } catch (e) {}
      updateTransformInputs();
    };

    document.getElementById("fill-color").addEventListener("change", (e) => {
      const hex = e.target.value;
      const fv = document.getElementById("fill-opacity").value;
      const opacity = fv === "" ? 100 : parseFloat(fv);
      const noFill = document.getElementById("no-fill").checked;
      editor.selected.forEach((s) => {
        if (noFill) s.fill = null;
        else s.fill = hexToRgbA(hex, opacity);
      });
      editor.pushHistory();
      redrawCanvas();
      updateInspector();
    });
    document.getElementById("stroke-color").addEventListener("change", (e) => {
      const hex = e.target.value;
      const sv = document.getElementById("stroke-opacity").value;
      const opacity = sv === "" ? 100 : parseFloat(sv);
      const noStroke = document.getElementById("no-stroke").checked;
      editor.selected.forEach((s) => {
        if (noStroke) s.stroke = null;
        else s.stroke = hexToRgbA(hex, opacity);
      });
      editor.pushHistory();
      redrawCanvas();
      updateInspector();
    });
    // opacity and no-fill/no-stroke handlers
    const fillOpacityEl = document.getElementById("fill-opacity");
    const strokeOpacityEl = document.getElementById("stroke-opacity");
    const noFillEl = document.getElementById("no-fill");
    const noStrokeEl = document.getElementById("no-stroke");
    if (fillOpacityEl) {
      fillOpacityEl.addEventListener("input", (e) => {
        // allow 0 value (don't coerce to truthy)
        const v = e.target.value;
        const opacity = v === "" ? 100 : parseFloat(v);
        const hex = document.getElementById("fill-color").value;
        const noFill = noFillEl && noFillEl.checked;
        editor.selected.forEach((s) => {
          if (noFill) s.fill = null;
          else s.fill = hexToRgbA(hex, opacity);
        });
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    }
    if (strokeOpacityEl) {
      strokeOpacityEl.addEventListener("input", (e) => {
        const v = e.target.value;
        const opacity = v === "" ? 100 : parseFloat(v);
        const hex = document.getElementById("stroke-color").value;
        const noStroke = noStrokeEl && noStrokeEl.checked;
        editor.selected.forEach((s) => {
          if (noStroke) s.stroke = null;
          else s.stroke = hexToRgbA(hex, opacity);
        });
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    }
    if (noFillEl) {
      noFillEl.addEventListener("change", (e) => {
        const checked = e.target.checked;
        const hex = document.getElementById("fill-color").value;
        const fv = document.getElementById("fill-opacity").value;
        const opacity = fv === "" ? 100 : parseFloat(fv);
        editor.selected.forEach((s) => {
          s.fill = checked ? null : hexToRgbA(hex, opacity);
        });
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    }
    if (noStrokeEl) {
      noStrokeEl.addEventListener("change", (e) => {
        const checked = e.target.checked;
        const hex = document.getElementById("stroke-color").value;
        const sv = document.getElementById("stroke-opacity").value;
        const opacity = sv === "" ? 100 : parseFloat(sv);
        editor.selected.forEach((s) => {
          s.stroke = checked ? null : hexToRgbA(hex, opacity);
        });
        editor.pushHistory();
        redrawCanvas();
        updateInspector();
      });
    }
    document.getElementById("stroke-weight").addEventListener("change", (e) => {
      const v = parseFloat(e.target.value);
      const isZero = !isNaN(v) && v === 0;
      editor.selected.forEach((s) => {
        s.strokeWeight = isNaN(v)
          ? s.strokeWeight !== undefined
            ? s.strokeWeight
            : 1
          : v;
        if (isZero) {
          // make stroke disappear
          s.stroke = null;
        } else if (s.stroke === null || s.stroke === undefined) {
          // if stroke is null but weight is >0, use UI color as fallback
          s.stroke = document.getElementById("stroke-color").value;
        }
      });
      editor.pushHistory();
      redrawCanvas();
      updateInspector();
    });

    document.getElementById("export-btn").addEventListener("click", () => {
      // open export modal
      const modal = document.getElementById("export-modal");
      if (!modal) return;
      document.getElementById("export-format").value = "json";
      document.getElementById("export-filename").value = "scene";
      modal.style.display = "flex";
    });

    // export modal buttons
    const exportCancel = document.getElementById("export-cancel");
    const exportDo = document.getElementById("export-do");
    if (exportCancel)
      exportCancel.addEventListener("click", () => {
        document.getElementById("export-modal").style.display = "none";
      });
    if (exportDo)
      exportDo.addEventListener("click", () => {
        const fmt = document.getElementById("export-format").value;
        const name =
          document.getElementById("export-filename").value || "scene";
        document.getElementById("export-modal").style.display = "none";
        if (fmt === "json") {
          const dataStr = JSON.stringify(editor.toJSON(), null, 2);
          const blob = new Blob([dataStr], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = name + ".json";
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 500);
        } else if (fmt === "p5") {
          const src = editor.exportP5Source();
          const blob = new Blob([src], { type: "text/javascript" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = name + ".js";
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 500);
        } else if (fmt === "png" || fmt === "svg") {
          // render current canvas to dataURL
          try {
            const cvs = document.querySelector("#canvas-holder canvas");
            if (!cvs) return showNotification("Canvas not found", "error");
            const dataUrl = cvs.toDataURL("image/png");
            if (fmt === "png") {
              const a = document.createElement("a");
              a.href = dataUrl;
              a.download = name + ".png";
              a.click();
            } else {
              // create a simple SVG that embeds the PNG as fallback
              const svg = `<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">\n  <image href="${dataUrl}" width="800" height="800"/>\n</svg>`;
              const blob = new Blob([svg], { type: "image/svg+xml" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = name + ".svg";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 500);
            }
          } catch (e) {
            showNotification("Export failed: " + e, "error");
          }
        }
      });

    document.getElementById("import-file").addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target.result);
          editor.loadJSON(parsed);
          redrawCanvas();
        } catch (err) {
          showNotification("Invalid JSON file", "error");
        }
      };
      r.readAsText(f);
    });

    // Palette import/export and harmony generator
    const paletteExportBtn = document.createElement("button");
    paletteExportBtn.textContent = "Export Palette";
    paletteExportBtn.addEventListener("click", () => {
      try {
        const blob = new Blob([JSON.stringify(editor.palette, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "palette.json";
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {}
    });
    // insert next to palette container when present
    if (paletteEl && paletteEl.parentNode)
      paletteEl.parentNode.appendChild(paletteExportBtn);

    const paletteImport = document.createElement("input");
    paletteImport.type = "file";
    paletteImport.accept = "application/json";
    paletteImport.addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = (e) => {
        try {
          const arr = JSON.parse(e.target.result);
          if (Array.isArray(arr)) {
            // append colors
            arr.forEach((c) => {
              const hc = normalizeToHex(c) || c;
              if (hc && !editor.palette.includes(hc)) editor.palette.push(hc);
            });
            try {
              localStorage.setItem(
                "p5_palette",
                JSON.stringify(editor.palette)
              );
            } catch (e) {}
            renderPalette();
          }
        } catch (err) {
          showNotification("Invalid palette file", "error");
        }
      };
      r.readAsText(f);
    });
    if (paletteEl && paletteEl.parentNode)
      paletteEl.parentNode.appendChild(paletteImport);

    // harmony generator: complementary & analogous
    const harmonyWrap = document.createElement("div");
    harmonyWrap.style.marginTop = "6px";
    const compBtn = document.createElement("button");
    compBtn.textContent = "Complementary";
    const analBtn = document.createElement("button");
    analBtn.textContent = "Analogous";
    harmonyWrap.appendChild(compBtn);
    harmonyWrap.appendChild(analBtn);
    if (paletteEl && paletteEl.parentNode)
      paletteEl.parentNode.appendChild(harmonyWrap);
    function hexToHsl(hex) {
      const m = String(hex).match(/#([0-9a-fA-F]{6})/);
      if (!m) return null;
      const r = parseInt(m[1].slice(0, 2), 16) / 255;
      const g = parseInt(m[1].slice(2, 4), 16) / 255;
      const b = parseInt(m[1].slice(4, 6), 16) / 255;
      const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
      let h = 0,
        s = 0,
        l = (max + min) / 2;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r:
            h = (g - b) / d + (g < b ? 6 : 0);
            break;
          case g:
            h = (b - r) / d + 2;
            break;
          case b:
            h = (r - g) / d + 4;
            break;
        }
        h = h / 6;
      }
      return { h: h * 360, s: s, l: l };
    }
    function hslToHex(h, s, l) {
      h /= 360;
      let r, g, b;
      if (s === 0) r = g = b = l;
      else {
        const hue2rgb = (p, q, t) => {
          if (t < 0) t += 1;
          if (t > 1) t -= 1;
          if (t < 1 / 6) return p + (q - p) * 6 * t;
          if (t < 1 / 2) return q;
          if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
          return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
      }
      const toHex = (x) =>
        Math.round(x * 255)
          .toString(16)
          .padStart(2, "0");
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }
    compBtn.addEventListener("click", () => {
      // take current selected target color or first palette color
      let src =
        editor.palette[0] ||
        (primaryEl &&
          normalizeToHex(getComputedStyle(primaryEl).backgroundColor));
      if (!src) return;
      const hsl = hexToHsl(src);
      if (!hsl) return;
      const comp = hslToHex((hsl.h + 180) % 360, hsl.s, hsl.l);
      if (!editor.palette.includes(comp)) editor.palette.push(comp);
      try {
        localStorage.setItem("p5_palette", JSON.stringify(editor.palette));
      } catch (e) {}
      renderPalette();
    });
    analBtn.addEventListener("click", () => {
      let src =
        editor.palette[0] ||
        (primaryEl &&
          normalizeToHex(getComputedStyle(primaryEl).backgroundColor));
      if (!src) return;
      const hsl = hexToHsl(src);
      if (!hsl) return;
      const a1 = hslToHex((hsl.h + 30) % 360, hsl.s, hsl.l);
      const a2 = hslToHex((hsl.h - 30 + 360) % 360, hsl.s, hsl.l);
      [a1, a2].forEach((c) => {
        if (!editor.palette.includes(c)) editor.palette.push(c);
      });
      try {
        localStorage.setItem("p5_palette", JSON.stringify(editor.palette));
      } catch (e) {}
      renderPalette();
    });

    // import sketch.js handler
    const importSketch = document.getElementById("import-sketch");
    if (importSketch)
      importSketch.addEventListener("change", (ev) => {
        const f = ev.target.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = (e) => {
          try {
            const src = e.target.result;
            const shapes = editor.parseSketchSource(src);
            shapes.forEach((s) => editor.addShape(s));
            redrawCanvas();
            window.updateLayerList && window.updateLayerList();
          } catch (err) {
            showNotification("Failed to import sketch.js: " + err, "error");
          }
        };
        r.readAsText(f);
      });

    document
      .getElementById("export-p5-source")
      .addEventListener("click", () => {
        // improved export: include transforms and robust color handling
        const src = editor.exportP5Source();
        // helper to trigger download and revoke objectURL after a short delay
        function downloadText(filename, text, mime = "text/javascript") {
          try {
            const blob = new Blob([text], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            // cleanup
            setTimeout(() => {
              try {
                URL.revokeObjectURL(url);
              } catch (e) {}
              if (a.parentNode) a.parentNode.removeChild(a);
            }, 500);
          } catch (e) {
            // fallback: open data URL (may fail for large content)
            const dataUrl =
              "data:" +
              mime +
              ";base64," +
              btoa(unescape(encodeURIComponent(text)));
            const a = document.createElement("a");
            a.href = dataUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            if (a.parentNode) a.parentNode.removeChild(a);
          }
        }

        downloadText("exported_sketch.js", src, "text/javascript");
      });

    document.getElementById("save-local").addEventListener("click", () => {
      localStorage.setItem("p5scene", JSON.stringify(editor.toJSON()));
    });
    document.getElementById("load-local").addEventListener("click", () => {
      const v = localStorage.getItem("p5scene");
      if (v) {
        editor.loadJSON(JSON.parse(v));
        redrawCanvas();
      }
    });

    document.getElementById("apply-json").addEventListener("click", () => {
      const t = document.getElementById("json-inspector").value;
      if (!t) return;
      try {
        const parsed = JSON.parse(t);
        // if single object representing a shape or group, update selected
        if (editor.selected.length === 1) {
          const sel = editor.selected[0];
          // apply allowed fields
          Object.assign(sel, parsed);
          redrawCanvas();
          updateInspector();
        } else {
          showNotification("Select exactly one item to apply JSON", "error");
        }
      } catch (err) {
        showNotification("Invalid JSON", "error");
      }
    });

    document.getElementById("apply-scene").addEventListener("click", () => {
      const t = document.getElementById("scene-json").value;
      if (!t) return;
      try {
        const parsed = JSON.parse(t);
        editor.loadJSON(parsed);
        redrawCanvas();
      } catch (err) {
        showNotification("Invalid Scene JSON", "error");
      }
    });

    updateModeButtons();
    // Arrange button handlers
    function alignSelected(mode) {
      if (editor.selected.length < 2) return;
      // compute reference based on selection bounds
      const bounds = editor.selected
        .map((s) => {
          const b =
            s.type === "group" ? editor._groupBounds(s) : s._computeBounds();
          return b
            ? {
                x: (s.x || 0) + b.x,
                y: (s.y || 0) + b.y,
                w: b.w,
                h: b.h,
                centerX: (s.x || 0) + b.x + b.w / 2,
                centerY: (s.y || 0) + b.y + b.h / 2,
              }
            : null;
        })
        .filter(Boolean);
      if (!bounds.length) return;
      let ref;
      if (mode.includes("left")) ref = Math.min(...bounds.map((b) => b.x));
      else if (mode.includes("right"))
        ref = Math.max(...bounds.map((b) => b.x + b.w));
      else if (mode.includes("center"))
        ref = bounds.reduce((a, b) => a + b.centerX, 0) / bounds.length;
      else if (mode.includes("top")) ref = Math.min(...bounds.map((b) => b.y));
      else if (mode.includes("bottom"))
        ref = Math.max(...bounds.map((b) => b.y + b.h));
      else if (mode.includes("middle"))
        ref = bounds.reduce((a, b) => a + b.centerY, 0) / bounds.length;
      editor.selected.forEach((s, i) => {
        const b = bounds[i];
        if (!b) return;
        if (mode === "left") s.x = ref - b.x + (s.x || 0);
        else if (mode === "right") s.x = ref - (b.x + b.w) + (s.x || 0);
        else if (mode === "center") s.x = ref - b.centerX + (s.x || 0);
        else if (mode === "top") s.y = ref - b.y + (s.y || 0);
        else if (mode === "bottom") s.y = ref - (b.y + b.h) + (s.y || 0);
        else if (mode === "middle") s.y = ref - b.centerY + (s.y || 0);
      });
      editor.pushHistory();
      redrawCanvas();
      updateInspector();
    }
    document
      .getElementById("align-left")
      .addEventListener("click", () => alignSelected("left"));
    document
      .getElementById("align-center")
      .addEventListener("click", () => alignSelected("center"));
    document
      .getElementById("align-right")
      .addEventListener("click", () => alignSelected("right"));
    document
      .getElementById("align-top")
      .addEventListener("click", () => alignSelected("top"));
    document
      .getElementById("align-middle")
      .addEventListener("click", () => alignSelected("middle"));
    document
      .getElementById("align-bottom")
      .addEventListener("click", () => alignSelected("bottom"));

    function distributeSelected(axis) {
      if (editor.selected.length < 3) return;
      const items = editor.selected.slice();
      const bounds = items
        .map((s) => {
          const b =
            s.type === "group" ? editor._groupBounds(s) : s._computeBounds();
          return { s, b };
        })
        .filter((x) => x.b);
      if (bounds.length < 3) return;
      if (axis === "h") {
        bounds.sort(
          (a, b) => (a.s.x || 0) + (a.b.x || 0) - ((b.s.x || 0) + (b.b.x || 0))
        );
        const first = (bounds[0].s.x || 0) + bounds[0].b.x;
        const last =
          (bounds[bounds.length - 1].s.x || 0) +
          bounds[bounds.length - 1].b.x +
          bounds[bounds.length - 1].b.w;
        const totalSpace = last - first;
        const gap = totalSpace / (bounds.length - 1);
        for (let i = 0; i < bounds.length; i++) {
          const tgt = first + i * gap - bounds[i].b.x - (bounds[i].s.x || 0);
          bounds[i].s.x = tgt;
        }
      } else {
        bounds.sort(
          (a, b) => (a.s.y || 0) + (a.b.y || 0) - ((b.s.y || 0) + (b.b.y || 0))
        );
        const first = (bounds[0].s.y || 0) + bounds[0].b.y;
        const last =
          (bounds[bounds.length - 1].s.y || 0) +
          bounds[bounds.length - 1].b.y +
          bounds[bounds.length - 1].b.h;
        const totalSpace = last - first;
        const gap = totalSpace / (bounds.length - 1);
        for (let i = 0; i < bounds.length; i++) {
          const tgt = first + i * gap - bounds[i].b.y - (bounds[i].s.y || 0);
          bounds[i].s.y = tgt;
        }
      }
      editor.pushHistory();
      redrawCanvas();
      updateInspector();
    }
    document
      .getElementById("distribute-h")
      .addEventListener("click", () => distributeSelected("h"));
    document
      .getElementById("distribute-v")
      .addEventListener("click", () => distributeSelected("v"));

    function reorderSelected(action) {
      if (!editor.selected.length) return;
      // work on first selected for single-item reorder
      const sel = editor.selected[0];
      const idx = editor.scene.findIndex((s) => s.id === sel.id);
      if (idx < 0) return;
      if (action === "bring-forward" && idx < editor.scene.length - 1) {
        const it = editor.scene.splice(idx, 1)[0];
        editor.scene.splice(idx + 1, 0, it);
      } else if (action === "send-back" && idx > 0) {
        const it = editor.scene.splice(idx, 1)[0];
        editor.scene.splice(idx - 1, 0, it);
      } else if (action === "bring-front") {
        const it = editor.scene.splice(idx, 1)[0];
        editor.scene.push(it);
      } else if (action === "send-backmost") {
        const it = editor.scene.splice(idx, 1)[0];
        editor.scene.unshift(it);
      }
      editor.pushHistory();
      window.updateLayerList && window.updateLayerList();
      redrawCanvas();
      updateInspector();
    }
    document
      .getElementById("bring-forward")
      .addEventListener("click", () => reorderSelected("bring-forward"));
    document
      .getElementById("send-back")
      .addEventListener("click", () => reorderSelected("send-back"));
    document
      .getElementById("bring-front")
      .addEventListener("click", () => reorderSelected("bring-front"));
    document
      .getElementById("send-backmost")
      .addEventListener("click", () => reorderSelected("send-backmost"));

    // Tab switching
    document.querySelectorAll(".tab-button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        document
          .querySelectorAll(".tab-button")
          .forEach((b) => b.classList.remove("active"));
        document
          .querySelectorAll(".tab-content")
          .forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(tab + "-tab").classList.add("active");
      });
    });
  }

  // Global keyboard shortcuts (undo/redo)
  window.addEventListener("keydown", (e) => {
    if (!editor) return;

    // avoid triggering single-key shortcuts while typing
    const ae = document.activeElement;
    if (ae) {
      const tag = (ae.tagName || "").toLowerCase();
      const typing =
        tag === "input" || tag === "textarea" || ae.isContentEditable;
      if (typing && !(e.ctrlKey || e.metaKey)) return;
    }
    // Delete / Backspace: if a vertex is selected delete vertex, else delete selection
    if (e.key === "Delete" || e.key === "Backspace") {
      if (editor._selectedVertex) {
        const sv = editor._selectedVertex;
        const s = sv.shape;
        const idx = sv.index;
        if (s && s.vertices && s.vertices.length > 3) {
          s.vertices.splice(idx, 1);
          editor._selectedVertex = null;
          editor.pushHistory();
          redrawCanvas();
          updateInspector();
        }
        e.preventDefault();
        return;
      }
      if (editor.selected.length) {
        editor.selected.forEach((s) => editor.removeShapeById(s.id));
        editor.clearSelection();
        redrawCanvas();
        updateInspector();
        e.preventDefault();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      editor.undo();
      redrawCanvas();
      updateInspector();
    }
    if (
      (e.ctrlKey || e.metaKey) &&
      (e.key.toLowerCase() === "y" ||
        (e.shiftKey && e.key.toLowerCase() === "z"))
    ) {
      e.preventDefault();
      editor.redo();
      redrawCanvas();
      updateInspector();
    }
    // Duplicate: Ctrl/Cmd + D
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      editor.duplicateSelection();
      redrawCanvas();
      updateInspector();
      return;
    }
    // Group: Ctrl/Cmd + G
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === "g" &&
      !e.shiftKey
    ) {
      e.preventDefault();
      editor.groupSelected();
      redrawCanvas();
      updateInspector();
      return;
    }
    // Ungroup: Ctrl/Cmd + Shift + G
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g" && e.shiftKey) {
      e.preventDefault();
      if (editor.selected[0] && editor.selected[0].type === "group") {
        editor.ungroup(editor.selected[0]);
        redrawCanvas();
        updateInspector();
      }
      return;
    }

    // Escape cancels draw tools
    if (e.key === "Escape") {
      if (editor.mode === "draw-line" || editor.mode === "draw-bezier") {
        editor.mode = "select";
        editor.drawTool.kind = null;
        editor.drawTool.active = false;
        editor.drawTool.points = [];
        editor.drawTool.start = null;
        editor.drawTool.current = null;
        editor.drawTool.cursor = null;
        updateModeButtons();
        updateStatusBar();
        redrawCanvas();
        e.preventDefault();
        return;
      }
    }

    // Line tool: L
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "l") {
      editor.mode = "draw-line";
      editor.drawTool.kind = "line";
      editor.drawTool.active = false;
      editor.drawTool.points = [];
      editor.drawTool.start = null;
      editor.drawTool.current = null;
      editor.drawTool.cursor = null;
      updateModeButtons();
      updateStatusBar();
      redrawCanvas();
      e.preventDefault();
      return;
    }

    // Bezier tool: B (click 4 points)
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "b") {
      editor.mode = "draw-bezier";
      editor.drawTool.kind = "bezier";
      editor.drawTool.active = false;
      editor.drawTool.points = [];
      editor.drawTool.start = null;
      editor.drawTool.current = null;
      editor.drawTool.cursor = null;
      updateModeButtons();
      updateStatusBar();
      redrawCanvas();
      e.preventDefault();
      return;
    }
  });

  function updateModeButtons() {
    document.getElementById("tool-select").style.fontWeight =
      editor.mode === "select" ||
      editor.mode === "draw-line" ||
      editor.mode === "draw-bezier"
        ? "700"
        : "400";
    document.getElementById("tool-vertex").style.fontWeight =
      editor.mode === "vertex" ? "700" : "400";
    // ensure lasso button reflects active state as well
    const lassoBtn = document.getElementById("tool-lasso");
    if (lassoBtn)
      lassoBtn.style.fontWeight = editor.mode === "lasso" ? "700" : "400";
  }

  function updateInspector() {
    const ti = document.getElementById("json-inspector");
    const ts = document.getElementById("scene-json");
    const fillInput = document.getElementById("fill-color");
    const strokeInput = document.getElementById("stroke-color");
    const fillOpacityEl = document.getElementById("fill-opacity");
    const strokeOpacityEl = document.getElementById("stroke-opacity");
    const noFillEl = document.getElementById("no-fill");
    const noStrokeEl = document.getElementById("no-stroke");
    try {
      if (editor.selected.length === 1) {
        const sel = editor.selected[0];
        if (ti) ti.value = JSON.stringify(sel.toJSON(), null, 2);

        // sync color inputs and visible swatches
        if (fillInput && sel.fill) {
          fillInput.value = colorToHex(sel.fill) || fillInput.value;
          try {
            if (fillSwatch) fillSwatch.style.background = fillInput.value;
          } catch (e) {}
        }
        if (strokeInput && sel.stroke) {
          strokeInput.value = colorToHex(sel.stroke) || strokeInput.value;
          try {
            if (strokeSwatch) strokeSwatch.style.background = strokeInput.value;
          } catch (e) {}
        }

        // set opacity sliders and no-fill/no-stroke
        if (fillOpacityEl && noFillEl) {
          const f = extractHexAndOpacity(sel.fill);
          noFillEl.checked = !f.hex;
          if (f.hex) fillOpacityEl.value = f.opacityPct;
        }
        if (strokeOpacityEl && noStrokeEl) {
          const s = extractHexAndOpacity(sel.stroke);
          const hasStroke =
            sel.stroke !== null &&
            sel.stroke !== undefined &&
            sel.strokeWeight !== 0 &&
            s.hex;
          noStrokeEl.checked = !hasStroke;
          if (s.hex) strokeOpacityEl.value = s.opacityPct;
        }

        // handle text/image specific inspector inputs
        if (sel.type === "image") {
          const ii = document.getElementById("inspector-image-url");
          if (ii)
            ii.value =
              (sel.commands && sel.commands[0] && sel.commands[0].src) || "";
        } else {
          const it = document.getElementById("inspector-text-input");
          const ii = document.getElementById("inspector-image-url");
          if (it) it.value = sel.text || "";
          if (ii) ii.value = "";
        }
      } else {
        const it2 = document.getElementById("inspector-text-input");
        const ii2 = document.getElementById("inspector-image-url");
        if (it2) it2.value = "";
        if (ii2) ii2.value = "";
        if (ti) ti.value = "";
      }
    } catch (e) {}

    // refresh history panel small indicator
    try {
      if (typeof window.updateHistoryPanel === "function")
        window.updateHistoryPanel();
    } catch (e) {}
  }

  // convert a css-like color (hex, rgb(...), rgba(...)) or array to #rrggbb
  function colorToHex(c) {
    if (!c) return null;
    if (Array.isArray(c)) {
      const [r, g, b] = c;
      return (
        "#" +
        [r, g, b]
          .map((v) => Math.round(v).toString(16).padStart(2, "0"))
          .join("")
      );
    }
    if (typeof c === "string") {
      const hexm = c.match(/#([0-9a-fA-F]{6})/);
      if (hexm) return "#" + hexm[1];
      const rgbm = c.match(
        /rgba?\s*\(\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*,\s*([0-9\.]+)(?:\s*,\s*([0-9\.]+)\s*)?\)/i
      );
      if (rgbm) {
        const r = Math.round(parseFloat(rgbm[1]));
        const g = Math.round(parseFloat(rgbm[2]));
        const b = Math.round(parseFloat(rgbm[3]));
        return (
          "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")
        );
      }
    }
    return null;
  }

  // returns { hex: '#rrggbb' or null, opacityPct: 0..100 }
  function extractHexAndOpacity(c) {
    if (!c) return { hex: null, opacityPct: 100 };
    if (Array.isArray(c)) {
      const [r, g, b, a] = c;
      const hex = colorToHex([r, g, b]);
      const alpha = a === undefined ? 255 : a;
      const pct = Math.round((parseFloat(alpha) / 255) * 100);
      return { hex, opacityPct: pct };
    }
    if (typeof c === "string") {
      const hexm = c.match(/#([0-9a-fA-F]{6})/);
      if (hexm) return { hex: "#" + hexm[1], opacityPct: 100 };
      const rgba = c.match(
        /rgba?\s*\(\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*,\s*([0-9\.]+)\s*,?\s*([0-9\.]*)\s*\)/i
      );
      if (rgba) {
        const r = Math.round(parseFloat(rgba[1]));
        const g = Math.round(parseFloat(rgba[2]));
        const b = Math.round(parseFloat(rgba[3]));
        let a = rgba[4];
        if (a === undefined || a === "") a = 255;
        else {
          // if alpha looks like 0..1, convert to 0..255
          const aval = parseFloat(a);
          if (aval <= 1) a = Math.round(aval * 255);
          else a = Math.round(aval);
        }
        const hex = colorToHex(`rgb(${r},${g},${b})`);
        const pct = Math.round((parseFloat(a) / 255) * 100);
        return { hex, opacityPct: pct };
      }
    }
    return { hex: null, opacityPct: 100 };
  }

  // convert #rrggbb and opacity percent (0..100) to rgb/rgba string where alpha is 0..255
  function hexToRgbA(hex, opacityPct) {
    if (!hex) return null;
    const m = hex.match(/#([0-9a-fA-F]{6})/);
    if (!m) return null;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const a = Math.round((parseFloat(opacityPct) / 100) * 255);
    if (a >= 255) return `rgb(${r},${g},${b})`;
    return `rgba(${r},${g},${b},${a})`;
  }

  // expose small helpers to window for debugging
  window.redrawCanvas = redrawCanvas;
  window.updateInspector = updateInspector;
};

new p5(sketch);
