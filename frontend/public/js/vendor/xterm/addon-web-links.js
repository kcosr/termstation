"use strict";
var WebLinksAddon = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // addons/addon-web-links/src/WebLinksAddon.ts
  var WebLinksAddon_exports = {};
  __export(WebLinksAddon_exports, {
    WebLinksAddon: () => WebLinksAddon
  });

  // addons/addon-web-links/src/WebLinkProvider.ts
  var WebLinkProvider = class {
    constructor(_terminal, _regex, _handler, _options = {}) {
      this._terminal = _terminal;
      this._regex = _regex;
      this._handler = _handler;
      this._options = _options;
    }
    provideLinks(y, callback) {
      const links = LinkComputer.computeLink(y, this._regex, this._terminal, this._handler);
      callback(this._addCallbacks(links));
    }
    _addCallbacks(links) {
      return links.map((link) => {
        link.leave = this._options.leave;
        link.hover = (event, uri) => {
          if (this._options.hover) {
            const { range } = link;
            this._options.hover(event, uri, range);
          }
        };
        return link;
      });
    }
  };
  function isUrl(urlString) {
    try {
      const url = new URL(urlString);
      const parsedBase = url.password && url.username ? `${url.protocol}//${url.username}:${url.password}@${url.host}` : url.username ? `${url.protocol}//${url.username}@${url.host}` : `${url.protocol}//${url.host}`;
      return urlString.toLocaleLowerCase().startsWith(parsedBase.toLocaleLowerCase());
    } catch (e) {
      return false;
    }
  }
  var LinkComputer = class _LinkComputer {
    static computeLink(y, regex, terminal, activate) {
      const rex = new RegExp(regex.source, (regex.flags || "") + "g");
      const [lines, startLineIndex] = _LinkComputer._getWindowedLineStrings(y - 1, terminal);
      const line = lines.join("");
      let match;
      const result = [];
      while (match = rex.exec(line)) {
        const text = match[0];
        if (!isUrl(text)) {
          continue;
        }
        const [startY, startX] = _LinkComputer._mapStrIdx(terminal, startLineIndex, 0, match.index);
        const [endY, endX] = _LinkComputer._mapStrIdx(terminal, startY, startX, text.length);
        if (startY === -1 || startX === -1 || endY === -1 || endX === -1) {
          continue;
        }
        const range = {
          start: {
            x: startX + 1,
            y: startY + 1
          },
          end: {
            x: endX,
            y: endY + 1
          }
        };
        result.push({ range, text, activate });
      }
      return result;
    }
    /**
     * Get wrapped content lines for the current line index.
     * The top/bottom line expansion stops at whitespaces or length > 2048.
     * Returns an array with line strings and the top line index.
     *
     * NOTE: We pull line strings with trimRight=true on purpose to make sure
     * to correctly match urls with early wrapped wide chars. This corrupts the string index
     * for 1:1 backmapping to buffer positions, thus needs an additional correction in _mapStrIdx.
     */
    static _getWindowedLineStrings(lineIndex, terminal) {
      let line;
      let topIdx = lineIndex;
      let bottomIdx = lineIndex;
      let length = 0;
      let content = "";
      const lines = [];
      if (line = terminal.buffer.active.getLine(lineIndex)) {
        const currentContent = line.translateToString(true);
        if (line.isWrapped && currentContent[0] !== " ") {
          length = 0;
          while ((line = terminal.buffer.active.getLine(--topIdx)) && length < 2048) {
            content = line.translateToString(true);
            length += content.length;
            lines.push(content);
            if (!line.isWrapped || content.indexOf(" ") !== -1) {
              break;
            }
          }
          lines.reverse();
        }
        lines.push(currentContent);
        length = 0;
        while ((line = terminal.buffer.active.getLine(++bottomIdx)) && line.isWrapped && length < 2048) {
          content = line.translateToString(true);
          length += content.length;
          lines.push(content);
          if (content.indexOf(" ") !== -1) {
            break;
          }
        }
      }
      return [lines, topIdx];
    }
    /**
     * Map a string index back to buffer positions.
     * Returns buffer position as [lineIndex, columnIndex] 0-based,
     * or [-1, -1] in case the lookup ran into a non-existing line.
     */
    static _mapStrIdx(terminal, lineIndex, rowIndex, stringIndex) {
      const buf = terminal.buffer.active;
      const cell = buf.getNullCell();
      let start = rowIndex;
      while (stringIndex) {
        const line = buf.getLine(lineIndex);
        if (!line) {
          return [-1, -1];
        }
        for (let i = start; i < line.length; ++i) {
          line.getCell(i, cell);
          const chars = cell.getChars();
          const width = cell.getWidth();
          if (width) {
            stringIndex -= chars.length || 1;
            if (i === line.length - 1 && chars === "") {
              const line2 = buf.getLine(lineIndex + 1);
              if (line2 && line2.isWrapped) {
                line2.getCell(0, cell);
                if (cell.getWidth() === 2) {
                  stringIndex += 1;
                }
              }
            }
          }
          if (stringIndex < 0) {
            return [lineIndex, i];
          }
        }
        lineIndex++;
        start = 0;
      }
      return [lineIndex, start];
    }
  };

  // addons/addon-web-links/src/WebLinksAddon.ts
  var strictUrlRegex = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;
  function handleLink(event, uri) {
    const newWindow = window.open();
    if (newWindow) {
      try {
        newWindow.opener = null;
      } catch {
      }
      newWindow.location.href = uri;
    } else {
      console.warn("Opening link blocked as opener could not be cleared");
    }
  }
  var WebLinksAddon = class {
    constructor(_handler = handleLink, _options = {}) {
      this._handler = _handler;
      this._options = _options;
    }
    activate(terminal) {
      this._terminal = terminal;
      const options = this._options;
      const regex = options.urlRegex || strictUrlRegex;
      this._linkProvider = this._terminal.registerLinkProvider(new WebLinkProvider(this._terminal, regex, this._handler, options));
    }
    dispose() {
      this._linkProvider?.dispose();
    }
  };
  return __toCommonJS(WebLinksAddon_exports);
})();
/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 */
