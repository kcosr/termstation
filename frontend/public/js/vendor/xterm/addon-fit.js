"use strict";
var FitAddon = (() => {
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

  // addons/addon-fit/src/FitAddon.ts
  var FitAddon_exports = {};
  __export(FitAddon_exports, {
    FitAddon: () => FitAddon
  });
  var MINIMUM_COLS = 2;
  var MINIMUM_ROWS = 1;
  var FitAddon = class {
    activate(terminal) {
      this._terminal = terminal;
    }
    dispose() {
    }
    fit() {
      const dims = this.proposeDimensions();
      if (!dims || !this._terminal || isNaN(dims.cols) || isNaN(dims.rows)) {
        return;
      }
      const core = this._terminal._core;
      if (this._terminal.rows !== dims.rows || this._terminal.cols !== dims.cols) {
        core._renderService.clear();
        this._terminal.resize(dims.cols, dims.rows);
      }
    }
    proposeDimensions() {
      if (!this._terminal) {
        return void 0;
      }
      if (!this._terminal.element || !this._terminal.element.parentElement) {
        return void 0;
      }
      const core = this._terminal._core;
      const dims = core._renderService.dimensions;
      if (dims.css.cell.width === 0 || dims.css.cell.height === 0) {
        return void 0;
      }
      const scrollbarWidth = this._terminal.options.scrollback === 0 ? 0 : this._terminal.options.overviewRuler?.width || 14 /* DEFAULT_SCROLL_BAR_WIDTH */;
      const parentElementStyle = window.getComputedStyle(this._terminal.element.parentElement);
      const parentElementHeight = parseInt(parentElementStyle.getPropertyValue("height"));
      const parentElementWidth = Math.max(0, parseInt(parentElementStyle.getPropertyValue("width")));
      const elementStyle = window.getComputedStyle(this._terminal.element);
      const elementPadding = {
        top: parseInt(elementStyle.getPropertyValue("padding-top")),
        bottom: parseInt(elementStyle.getPropertyValue("padding-bottom")),
        right: parseInt(elementStyle.getPropertyValue("padding-right")),
        left: parseInt(elementStyle.getPropertyValue("padding-left"))
      };
      const elementPaddingVer = elementPadding.top + elementPadding.bottom;
      const elementPaddingHor = elementPadding.right + elementPadding.left;
      const availableHeight = parentElementHeight - elementPaddingVer;
      const availableWidth = parentElementWidth - elementPaddingHor - scrollbarWidth;
      const geometry = {
        cols: Math.max(MINIMUM_COLS, Math.floor(availableWidth / dims.css.cell.width)),
        rows: Math.max(MINIMUM_ROWS, Math.floor(availableHeight / dims.css.cell.height))
      };
      return geometry;
    }
  };
  return __toCommonJS(FitAddon_exports);
})();
/**
 * Copyright (c) 2024 The xterm.js authors. All rights reserved.
 * @license MIT
 */
/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */
