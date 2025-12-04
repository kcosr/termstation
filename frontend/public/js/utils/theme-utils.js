/**
 * Theme utilities: determine effective theme and provide xterm palettes
 */

export function getEffectiveTheme() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (!attr || attr === 'auto') {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        return prefersDark ? 'dark' : 'light';
    }
    return attr;
}

export function getXtermTheme(theme = getEffectiveTheme(), { interactive = true } = {}) {
    let t;
    switch (theme) {
        case 'autumn-morning':
            t = {
                background: '#FAF3E0',
                foreground: '#2C2A27',
                cursor: interactive ? '#2C2A27' : 'transparent',
                selection: 'rgba(184, 100, 10, 0.22)',
                black: '#2C2A27',
                red: '#C2410C',
                green: '#4D7C0F',
                yellow: '#B8640A',
                blue: '#8E6E53',
                magenta: '#8D3B72',
                cyan: '#2F6F6D',
                white: '#E9E0D0',
                brightBlack: '#5C5146',
                brightRed: '#EA580C',
                brightGreen: '#6BAF2E',
                brightYellow: '#F59E0B',
                brightBlue: '#A07C5B',
                brightMagenta: '#A74C82',
                brightCyan: '#3FAFA8',
                brightWhite: '#ffffff'
            };
            break;
        case 'autumn-afternoon':
            t = {
                background: '#F6E6D1',
                foreground: '#2B1D12',
                cursor: interactive ? '#2B1D12' : 'transparent',
                selection: 'rgba(194, 65, 12, 0.22)',
                black: '#2B1D12',
                red: '#B84E1F',
                green: '#256B48',
                yellow: '#B8640A',
                blue: '#7A5942',
                magenta: '#9C4A6B',
                cyan: '#1F7D71',
                white: '#EAD8C0',
                brightBlack: '#5A3E2B',
                brightRed: '#EA580C',
                brightGreen: '#3FA46A',
                brightYellow: '#F59E0B',
                brightBlue: '#A07C5B',
                brightMagenta: '#B65C82',
                brightCyan: '#3FB6A8',
                brightWhite: '#ffffff'
            };
            break;
        case 'autumn-night':
            t = {
                background: '#1F1A17',
                foreground: '#EADFD3',
                cursor: interactive ? '#EADFD3' : 'transparent',
                selection: 'rgba(229, 142, 38, 0.25)',
                black: '#1A1512',
                red: '#D04E4E',
                green: '#7BA05B',
                yellow: '#D97706',
                blue: '#9A7E63',
                magenta: '#B26782',
                cyan: '#4E9A8F',
                white: '#EADFD3',
                brightBlack: '#3A2F28',
                brightRed: '#E26A6A',
                brightGreen: '#8FC274',
                brightYellow: '#E58E26',
                brightBlue: '#A07C5B',
                brightMagenta: '#C97A9B',
                brightCyan: '#67BFB4',
                brightWhite: '#ffffff'
            };
            break;
        case 'winter-morning':
            t = {
                background: '#F2F7FB',
                foreground: '#223047',
                cursor: interactive ? '#223047' : 'transparent',
                selection: 'rgba(14, 165, 233, 0.22)',
                black: '#223047',
                red: '#B91C1C',
                green: '#166534',
                yellow: '#B45309',
                blue: '#0369A1',
                magenta: '#7C3AED',
                cyan: '#0891B2',
                white: '#E6EEF6',
                brightBlack: '#556987',
                brightRed: '#EF4444',
                brightGreen: '#22C55E',
                brightYellow: '#F59E0B',
                brightBlue: '#38BDF8',
                brightMagenta: '#A78BFA',
                brightCyan: '#22D3EE',
                brightWhite: '#ffffff'
            };
            break;
        case 'winter-afternoon':
            t = {
                background: '#EAF2F8',
                foreground: '#1F2A44',
                cursor: interactive ? '#1F2A44' : 'transparent',
                selection: 'rgba(56, 189, 248, 0.22)',
                black: '#1F2A44',
                red: '#DC2626',
                green: '#15803D',
                yellow: '#D97706',
                blue: '#0EA5E9',
                magenta: '#8B5CF6',
                cyan: '#06B6D4',
                white: '#DDE7F2',
                brightBlack: '#354764',
                brightRed: '#F87171',
                brightGreen: '#22C55E',
                brightYellow: '#FBBF24',
                brightBlue: '#38BDF8',
                brightMagenta: '#A78BFA',
                brightCyan: '#22D3EE',
                brightWhite: '#ffffff'
            };
            break;
        case 'winter-night':
            t = {
                background: '#0B1220',
                foreground: '#E6F0FA',
                cursor: interactive ? '#E6F0FA' : 'transparent',
                selection: 'rgba(56, 189, 248, 0.25)',
                black: '#0B1220',
                red: '#F87171',
                green: '#34D399',
                yellow: '#F59E0B',
                blue: '#60A5FA',
                magenta: '#C084FC',
                cyan: '#22D3EE',
                white: '#E6F0FA',
                brightBlack: '#1F2A44',
                brightRed: '#FCA5A5',
                brightGreen: '#6EE7B7',
                brightYellow: '#FBBF24',
                brightBlue: '#93C5FD',
                brightMagenta: '#E9D5FF',
                brightCyan: '#67E8F9',
                brightWhite: '#ffffff'
            };
            break;
        case 'light':
            t = {
                background: '#ffffff',
                foreground: '#212529',
                cursor: interactive ? '#212529' : 'transparent',
                // Selection uses theme blue accent but lighter alpha for visibility without overpowering
                selection: 'rgba(0, 92, 197, 0.22)',
                black: '#000000',
                red: '#cc0000',
                green: '#007400',
                yellow: '#b58900',
                blue: '#005cc5',
                magenta: '#6f42c1',
                cyan: '#1b7c83',
                white: '#bbbbbb',
                brightBlack: '#555555',
                brightRed: '#e00000',
                brightGreen: '#008f00',
                brightYellow: '#d79921',
                brightBlue: '#0366d6',
                brightMagenta: '#8250df',
                brightCyan: '#158fad',
                brightWhite: '#111111'
            };
            break;
        case 'forest-dark':
            t = {
                background: '#0f1f17',
                foreground: '#dcefe2',
                cursor: interactive ? '#dcefe2' : 'transparent',
                selection: 'rgba(63, 160, 74, 0.25)',
                black: '#0b1d13',
                red: '#e57373',
                green: '#66bb6a',
                yellow: '#d4a932',
                blue: '#64b5f6',
                magenta: '#b39ddb',
                cyan: '#80deea',
                white: '#dcefe2',
                brightBlack: '#28543b',
                brightRed: '#ef9a9a',
                brightGreen: '#81c784',
                brightYellow: '#ffd54f',
                brightBlue: '#90caf9',
                brightMagenta: '#ce93d8',
                brightCyan: '#a7ffeb',
                brightWhite: '#ffffff'
            };
            break;
        case 'forest-light':
            t = {
                background: '#eaf4ec',
                foreground: '#2a4b31',
                cursor: interactive ? '#2a4b31' : 'transparent',
                selection: 'rgba(46, 125, 50, 0.22)',
                black: '#2a4b31',
                red: '#c62828',
                green: '#2e7d32',
                yellow: '#b8860b',
                blue: '#4a90e2',
                magenta: '#9b59b6',
                cyan: '#26a69a',
                white: '#b2c8b8',
                brightBlack: '#4e7b59',
                brightRed: '#e53935',
                brightGreen: '#388e3c',
                brightYellow: '#d4a932',
                brightBlue: '#64b5f6',
                brightMagenta: '#c39bd3',
                brightCyan: '#4dd0e1',
                brightWhite: '#ffffff'
            };
            break;
        case 'everforest-dark':
            t = {
                background: '#2b3339',
                foreground: '#d3c6aa',
                cursor: interactive ? '#d3c6aa' : 'transparent',
                selection: 'rgba(167, 192, 128, 0.25)',
                black: '#323d43',
                red: '#e67e80',
                green: '#a7c080',
                yellow: '#dbbc7f',
                blue: '#7fbbb3',
                magenta: '#d699b6',
                cyan: '#83c092',
                white: '#d3c6aa',
                brightBlack: '#4c555b',
                brightRed: '#e67e80',
                brightGreen: '#a7c080',
                brightYellow: '#dbbc7f',
                brightBlue: '#7fbbb3',
                brightMagenta: '#d699b6',
                brightCyan: '#83c092',
                brightWhite: '#f1efee'
            };
            break;
        case 'everforest-light':
            t = {
                background: '#f3f4f3',
                foreground: '#4c555a',
                cursor: interactive ? '#4c555a' : 'transparent',
                selection: 'rgba(141, 161, 1, 0.20)',
                black: '#5c666b',
                red: '#e68183',
                green: '#8da101',
                yellow: '#dfa000',
                blue: '#7fbbb3',
                magenta: '#d699b6',
                cyan: '#83c092',
                white: '#a7adba',
                brightBlack: '#7b868b',
                brightRed: '#f08c8e',
                brightGreen: '#9ec400',
                brightYellow: '#e0c06d',
                brightBlue: '#8fd0c9',
                brightMagenta: '#e0a8c0',
                brightCyan: '#97d1be',
                brightWhite: '#faf9f6'
            };
            break;
        case 'matrix':
            t = {
                background: '#000000',
                foreground: '#a8ff60',
                cursor: interactive ? '#00ff66' : 'transparent',
                selection: 'rgba(0, 255, 102, 0.2)',
                black: '#000000',
                red: '#ff3b3b',
                green: '#00ff66',
                yellow: '#c6ff00',
                blue: '#00ccff',
                magenta: '#cc66ff',
                cyan: '#33ffcc',
                white: '#d0ffd0',
                brightBlack: '#1a1a1a',
                brightRed: '#ff5555',
                brightGreen: '#33ff88',
                brightYellow: '#e6ff4d',
                brightBlue: '#66d9ff',
                brightMagenta: '#e0aaff',
                brightCyan: '#66ffdd',
                brightWhite: '#ffffff'
            };
            break;
        case 'dracula':
            t = {
                background: '#282a36',
                foreground: '#f8f8f2',
                cursor: interactive ? '#f8f8f2' : 'transparent',
                selection: 'rgba(68, 71, 90, 0.5)',
                black: '#21222c',
                red: '#ff5555',
                green: '#50fa7b',
                yellow: '#f1fa8c',
                blue: '#6272a4',
                magenta: '#bd93f9',
                cyan: '#8be9fd',
                white: '#f8f8f2',
                brightBlack: '#6272a4',
                brightRed: '#ff6e6e',
                brightGreen: '#69ff94',
                brightYellow: '#ffffa5',
                brightBlue: '#d6acff',
                brightMagenta: '#ff92df',
                brightCyan: '#a4ffff',
                brightWhite: '#ffffff'
            };
            break;
        case 'nord':
            t = {
                background: '#2E3440',
                foreground: '#FFFFFF',
                cursor: interactive ? '#FFFFFF' : 'transparent',
                selection: 'rgba(216, 222, 233, 0.25)',
                black: '#3B4252',
                red: '#BF616A',
                green: '#A3BE8C',
                yellow: '#EBCB8B',
                blue: '#81A1C1',
                magenta: '#B48EAD',
                cyan: '#88C0D0',
                white: '#E5E9F0',
                brightBlack: '#4C566A',
                brightRed: '#BF616A',
                brightGreen: '#A3BE8C',
                brightYellow: '#EBCB8B',
                brightBlue: '#81A1C1',
                brightMagenta: '#B48EAD',
                brightCyan: '#8FBCBB',
                brightWhite: '#ECEFF4'
            };
            break;
        case 'solarized-dark':
            t = {
                background: '#002b36',
                foreground: '#839496',
                cursor: interactive ? '#93a1a1' : 'transparent',
                selection: 'rgba(147, 161, 161, 0.25)',
                black: '#073642',
                red: '#dc322f',
                green: '#859900',
                yellow: '#b58900',
                blue: '#268bd2',
                magenta: '#d33682',
                cyan: '#2aa198',
                white: '#eee8d5',
                brightBlack: '#002b36',
                brightRed: '#cb4b16',
                brightGreen: '#586e75',
                brightYellow: '#657b83',
                brightBlue: '#839496',
                brightMagenta: '#6c71c4',
                brightCyan: '#93a1a1',
                brightWhite: '#fdf6e3'
            };
            break;
        case 'solarized-light':
            t = {
                background: '#fdf6e3',
                foreground: '#657b83',
                cursor: interactive ? '#657b83' : 'transparent',
                // Slightly lighter alpha for a softer selection
                selection: 'rgba(38, 139, 210, 0.24)',
                black: '#073642',
                red: '#dc322f',
                green: '#859900',
                yellow: '#b58900',
                blue: '#268bd2',
                magenta: '#d33682',
                cyan: '#2aa198',
                white: '#eee8d5',
                brightBlack: '#002b36',
                brightRed: '#cb4b16',
                brightGreen: '#586e75',
                brightYellow: '#657b83',
                brightBlue: '#839496',
                brightMagenta: '#6c71c4',
                brightCyan: '#93a1a1',
                brightWhite: '#fdf6e3'
            };
            break;
        case 'gruvbox-dark':
            t = {
                background: '#282828',
                foreground: '#ebdbb2',
                cursor: interactive ? '#ebdbb2' : 'transparent',
                selection: 'rgba(235, 219, 178, 0.25)',
                black: '#1d2021',
                red: '#cc241d',
                green: '#98971a',
                yellow: '#d79921',
                blue: '#458588',
                magenta: '#b16286',
                cyan: '#689d6a',
                white: '#a89984',
                brightBlack: '#928374',
                brightRed: '#fb4934',
                brightGreen: '#b8bb26',
                brightYellow: '#fabd2f',
                brightBlue: '#83a598',
                brightMagenta: '#d3869b',
                brightCyan: '#8ec07c',
                brightWhite: '#ebdbb2'
            };
            break;
        case 'monokai':
            t = {
                background: '#272822',
                foreground: '#f8f8f2',
                cursor: interactive ? '#f8f8f2' : 'transparent',
                selection: 'rgba(248, 248, 242, 0.2)',
                black: '#1e1f1c',
                red: '#f92672',
                green: '#a6e22e',
                yellow: '#f4bf75',
                blue: '#66d9ef',
                magenta: '#ae81ff',
                cyan: '#a1efe4',
                white: '#f8f8f2',
                brightBlack: '#75715e',
                brightRed: '#f92672',
                brightGreen: '#a6e22e',
                brightYellow: '#f4bf75',
                brightBlue: '#66d9ef',
                brightMagenta: '#ae81ff',
                brightCyan: '#a1efe4',
                brightWhite: '#f9f8f5'
            };
            break;
        case 'tokyo-night':
            t = {
                background: '#1a1b26',
                foreground: '#c0caf5',
                cursor: interactive ? '#c0caf5' : 'transparent',
                selection: 'rgba(122, 162, 247, 0.25)',
                black: '#1d202f',
                red: '#f7768e',
                green: '#9ece6a',
                yellow: '#e0af68',
                blue: '#7aa2f7',
                magenta: '#bb9af7',
                cyan: '#7dcfff',
                white: '#a9b1d6',
                brightBlack: '#414868',
                brightRed: '#f7768e',
                brightGreen: '#9ece6a',
                brightYellow: '#e0af68',
                brightBlue: '#7aa2f7',
                brightMagenta: '#bb9af7',
                brightCyan: '#7dcfff',
                brightWhite: '#c0caf5'
            };
            break;
        case 'catppuccin-mocha':
            t = {
                background: '#1e1e2e',
                foreground: '#cdd6f4',
                cursor: interactive ? '#cdd6f4' : 'transparent',
                selection: 'rgba(180, 190, 254, 0.25)',
                black: '#45475a',
                red: '#f38ba8',
                green: '#a6e3a1',
                yellow: '#f9e2af',
                blue: '#89b4fa',
                magenta: '#cba6f7',
                cyan: '#94e2d5',
                white: '#bac2de',
                brightBlack: '#585b70',
                brightRed: '#eba0ac',
                brightGreen: '#a6e3a1',
                brightYellow: '#f9e2af',
                brightBlue: '#89b4fa',
                brightMagenta: '#f5c2e7',
                brightCyan: '#94e2d5',
                brightWhite: '#cdd6f4'
            };
            break;
        case 'catppuccin-latte':
            t = {
                background: '#eff1f5',
                foreground: '#4c4f69',
                cursor: interactive ? '#4c4f69' : 'transparent',
                // Slightly lighter alpha to avoid overly strong blue on light bg
                selection: 'rgba(30, 102, 245, 0.24)',
                black: '#5c5f77',
                red: '#d20f39',
                green: '#40a02b',
                yellow: '#df8e1d',
                blue: '#1e66f5',
                magenta: '#ea76cb',
                cyan: '#179299',
                white: '#acb0be',
                brightBlack: '#6c6f85',
                brightRed: '#e64553',
                brightGreen: '#40a02b',
                brightYellow: '#df8e1d',
                brightBlue: '#1e66f5',
                brightMagenta: '#8839ef',
                brightCyan: '#04a5e5',
                brightWhite: '#ccd0da'
            };
            break;
        case 'one-dark':
            t = {
                background: '#282c34',
                foreground: '#abb2bf',
                cursor: interactive ? '#abb2bf' : 'transparent',
                selection: 'rgba(97, 175, 239, 0.25)',
                black: '#282c34',
                red: '#e06c75',
                green: '#98c379',
                yellow: '#e5c07b',
                blue: '#61afef',
                magenta: '#c678dd',
                cyan: '#56b6c2',
                white: '#abb2bf',
                brightBlack: '#5c6370',
                brightRed: '#e06c75',
                brightGreen: '#98c379',
                brightYellow: '#e5c07b',
                brightBlue: '#61afef',
                brightMagenta: '#c678dd',
                brightCyan: '#56b6c2',
                brightWhite: '#ffffff'
            };
            break;
        case 'night-owl':
            t = {
                background: '#011627',
                foreground: '#d6deeb',
                cursor: interactive ? '#d6deeb' : 'transparent',
                selection: 'rgba(130, 170, 255, 0.2)',
                black: '#011627',
                red: '#ef5350',
                green: '#22da6e',
                yellow: '#addb67',
                blue: '#82aaff',
                magenta: '#c792ea',
                cyan: '#21c7a8',
                white: '#d6deeb',
                brightBlack: '#2c3043',
                brightRed: '#ef5350',
                brightGreen: '#22da6e',
                brightYellow: '#addb67',
                brightBlue: '#82aaff',
                brightMagenta: '#c792ea',
                brightCyan: '#7fdbca',
                brightWhite: '#ffffff'
            };
            break;
        case 'gruvbox-light':
            t = {
                background: '#fbf1c7',
                foreground: '#3c3836',
                cursor: interactive ? '#3c3836' : 'transparent',
                // Selection tuned to warm amber (non-blue) for comparison
                selection: 'rgba(215, 153, 33, 0.30)',
                black: '#3c3836',
                red: '#cc241d',
                green: '#98971a',
                yellow: '#d79921',
                blue: '#458588',
                magenta: '#b16286',
                cyan: '#689d6a',
                white: '#7c6f64',
                brightBlack: '#928374',
                brightRed: '#9d0006',
                brightGreen: '#79740e',
                brightYellow: '#b57614',
                brightBlue: '#076678',
                brightMagenta: '#8f3f71',
                brightCyan: '#427b58',
                brightWhite: '#f2e5bc'
            };
            break;
        case 'dark':
        default:
            t = {
                background: '#1e1e1e',
                foreground: '#e0e0e0',
                cursor: interactive ? '#e0e0e0' : 'transparent',
                selection: 'rgba(255, 255, 255, 0.3)',
                black: '#000000',
                red: '#ff5555',
                green: '#50fa7b',
                yellow: '#f1fa8c',
                blue: '#6272a4',
                magenta: '#bd93f9',
                cyan: '#8be9fd',
                white: '#bbbbbb',
                brightBlack: '#555555',
                brightRed: '#ff5555',
                brightGreen: '#50fa7b',
                brightYellow: '#f1fa8c',
                brightBlue: '#6272a4',
                brightMagenta: '#bd93f9',
                brightCyan: '#8be9fd',
                brightWhite: '#ffffff'
            };
            break;
    }
    // Compatibility across xterm.js versions: ensure both keys are present
    if (t && t.selection && !t.selectionBackground) t.selectionBackground = t.selection;
    if (t && t.selectionBackground && !t.selection) t.selection = t.selectionBackground;
    return t;
}

/**
 * Subscribe to system color scheme changes. Returns an unsubscribe function.
 */
export function onSystemThemeChange(callback) {
    if (!window.matchMedia) return () => {};
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
        callback(mq.matches ? 'dark' : 'light');
    };
    // modern browsers
    if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }
    // fallback
    mq.addListener(handler);
    return () => mq.removeListener(handler);
}
