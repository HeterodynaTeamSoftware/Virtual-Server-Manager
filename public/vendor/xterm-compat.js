
(function () {
  const ESC = '\u001b';
  const FG = {
    30:'#111827',31:'#ef4444',32:'#22c55e',33:'#eab308',34:'#60a5fa',35:'#d946ef',36:'#22d3ee',37:'#e5e7eb',
    90:'#6b7280',91:'#f87171',92:'#4ade80',93:'#fde047',94:'#93c5fd',95:'#f0abfc',96:'#67e8f9',97:'#ffffff'
  };
  const BG = {
    40:'#111827',41:'#7f1d1d',42:'#14532d',43:'#713f12',44:'#1e3a8a',45:'#701a75',46:'#164e63',47:'#d1d5db',
    100:'#374151',101:'#b91c1c',102:'#15803d',103:'#a16207',104:'#1d4ed8',105:'#a21caf',106:'#0891b2',107:'#f9fafb'
  };

  function cloneStyle(style) {
    return { fg: style.fg, bg: style.bg, bold: !!style.bold, underline: !!style.underline, inverse: !!style.inverse };
  }

  function styleKey(style) {
    return [style.fg||'', style.bg||'', style.bold?'b':'', style.underline?'u':'', style.inverse?'i':''].join('|');
  }

  function cssFromStyle(style, defaults) {
    const fg = style.inverse ? (style.bg || defaults.bg) : (style.fg || defaults.fg);
    const bg = style.inverse ? (style.fg || defaults.fg) : (style.bg || defaults.bg);
    return [
      `color:${fg}`,
      `background:${bg}`,
      style.bold ? 'font-weight:700' : 'font-weight:400',
      style.underline ? 'text-decoration:underline' : 'text-decoration:none'
    ].join(';');
  }

  class TerminalCompat {
    constructor(options) {
      this.options = options || {};
      this.defaults = {
        fg: this.options.theme?.foreground || '#e5e7eb',
        bg: this.options.theme?.background || '#0b1220'
      };
      this.style = { fg: null, bg: null, bold: false, underline: false, inverse: false };
      this.currentLine = [];
      this.lines = [];
      this.pending = '';
      this.maxLines = this.options.scrollback || 1500;
      this.el = null;
      this.viewport = null;
      this.inputHandler = null;
      this.cols = this.options.cols || 120;
      this.rows = this.options.rows || 30;
    }

    open(el) {
      this.el = el;
      el.innerHTML = '';
      el.classList.add('xterm-compat-shell');
      const viewport = document.createElement('div');
      viewport.className = 'xterm-compat-viewport';
      el.appendChild(viewport);
      this.viewport = viewport;
      el.setAttribute('tabindex', '0');
      el.addEventListener('keydown', (event) => {
        if (!this.inputHandler) return;
        if (event.ctrlKey && event.key.toLowerCase() === 'v') return;
        if (event.key === 'Enter') { this.inputHandler('\r'); event.preventDefault(); return; }
        if (event.key === 'Backspace') { this.inputHandler('\x7f'); event.preventDefault(); return; }
        if (event.ctrlKey && event.key.toLowerCase() === 'c') { this.inputHandler('\x03'); event.preventDefault(); return; }
        if (event.key === 'Tab') { this.inputHandler('\t'); event.preventDefault(); return; }
        if (event.key.startsWith('Arrow')) {
          const seq = {ArrowUp:'\u001b[A',ArrowDown:'\u001b[B',ArrowRight:'\u001b[C',ArrowLeft:'\u001b[D'}[event.key];
          if (seq) { this.inputHandler(seq); event.preventDefault(); return; }
        }
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          this.inputHandler(event.key);
          event.preventDefault();
        }
      });
      this.refresh();
    }

    onData(handler) { this.inputHandler = handler; }
    focus() { this.el && this.el.focus(); }
    clear() { this.lines = []; this.currentLine = []; this.pending=''; this.refresh(); }
    resize(cols, rows) { this.cols = cols; this.rows = rows; if (this.el) { this.el.style.setProperty('--term-cols', cols); this.el.style.setProperty('--term-rows', rows); } }
    writeln(text) { this.write(String(text) + '\n'); }

    write(text) {
      if (text == null) return;
      let data = this.pending + String(text);
      this.pending = '';
      let i = 0;
      while (i < data.length) {
        const ch = data[i];
        if (ch === ESC) {
          const m = data.slice(i).match(/^\u001b\[([0-9;]*)([A-Za-z])/);
          if (!m) { this.pending = data.slice(i); break; }
          const params = (m[1] || '0').split(';').filter(Boolean).map(v => Number(v || 0));
          const cmd = m[2];
          if (cmd === 'm') this.applySgr(params.length ? params : [0]);
          i += m[0].length;
          continue;
        }
        if (ch === '\r') {
          this.currentLine = [];
          i += 1;
          continue;
        }
        if (ch === '\n') {
          this.pushCurrentLine();
          i += 1;
          continue;
        }
        if (ch === '\b') {
          const last = this.currentLine[this.currentLine.length - 1];
          if (last && last.text) {
            last.text = last.text.slice(0, -1);
            if (!last.text) this.currentLine.pop();
          }
          i += 1;
          continue;
        }
        this.appendText(ch);
        i += 1;
      }
      this.refresh();
    }

    applySgr(params) {
      for (const p of params) {
        if (p === 0) this.style = { fg: null, bg: null, bold: false, underline: false, inverse: false };
        else if (p === 1) this.style.bold = true;
        else if (p === 4) this.style.underline = true;
        else if (p === 7) this.style.inverse = true;
        else if (p === 22) this.style.bold = false;
        else if (p === 24) this.style.underline = false;
        else if (p === 27) this.style.inverse = false;
        else if (p === 39) this.style.fg = null;
        else if (p === 49) this.style.bg = null;
        else if (FG[p]) this.style.fg = FG[p];
        else if (BG[p]) this.style.bg = BG[p];
      }
    }

    appendText(text) {
      const key = styleKey(this.style);
      let chunk = this.currentLine[this.currentLine.length - 1];
      if (!chunk || chunk.key !== key) {
        chunk = { key, text: '', style: cloneStyle(this.style) };
        this.currentLine.push(chunk);
      }
      chunk.text += text;
    }

    pushCurrentLine() {
      this.lines.push(this.currentLine.length ? this.currentLine : [{ key: 'plain', text: '', style: cloneStyle(this.style) }]);
      this.currentLine = [];
      if (this.lines.length > this.maxLines) this.lines = this.lines.slice(this.lines.length - this.maxLines);
    }

    renderLine(chunks) {
      return chunks.map(chunk => {
        const escaped = chunk.text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/ /g, '&nbsp;');
        return `<span style="${cssFromStyle(chunk.style, this.defaults)}">${escaped || '&nbsp;'}</span>`;
      }).join('');
    }

    refresh() {
      if (!this.viewport) return;
      const rows = this.lines.slice();
      if (this.currentLine.length) rows.push(this.currentLine);
      this.viewport.innerHTML = rows.map(line => `<div class="xterm-compat-line">${this.renderLine(line)}</div>`).join('');
      this.viewport.scrollTop = this.viewport.scrollHeight;
    }

    getPlainText() {
      const rows = this.lines.slice();
      if (this.currentLine.length) rows.push(this.currentLine);
      return rows.map(line => line.map(chunk => chunk.text).join('')).join('\n');
    }
  }

  class FitAddonCompat {
    activate(term) { this.term = term; }
    fit() {
      if (!this.term || !this.term.el) return;
      const host = this.term.el;
      const styles = getComputedStyle(host);
      const width = host.clientWidth - parseFloat(styles.paddingLeft || 0) - parseFloat(styles.paddingRight || 0);
      const height = host.clientHeight - parseFloat(styles.paddingTop || 0) - parseFloat(styles.paddingBottom || 0);
      const cols = Math.max(60, Math.floor(width / 8.4));
      const rows = Math.max(18, Math.floor(height / 19));
      this.term.resize(cols, rows);
    }
  }

  window.Terminal = TerminalCompat;
  window.FitAddon = { FitAddon: FitAddonCompat };
})();
