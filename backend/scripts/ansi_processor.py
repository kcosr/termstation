#!/usr/bin/env python3
"""
ANSI Escape Sequence Processor

This script processes ANSI escape sequences in a log file and outputs the final text content
after applying all cursor movements, clear operations, and text positioning commands.
"""

import re
import sys
from typing import List, Dict, Tuple, Optional

class ANSIProcessor:
    def __init__(self):
        self.screen: List[List[str]] = []
        self.cursor_row = 0
        self.cursor_col = 0
        self.max_cols = 200  # Reasonable terminal width
        self.max_rows = 100  # Start with reasonable height
        
    def ensure_screen_size(self, row: int, col: int):
        """Ensure screen buffer is large enough for the given position"""
        # Extend rows if needed
        while len(self.screen) <= row:
            self.screen.append([' '] * self.max_cols)
        
        # Extend columns in existing rows if needed
        if col >= self.max_cols:
            new_cols = col + 50  # Add some buffer
            for screen_row in self.screen:
                screen_row.extend([' '] * (new_cols - len(screen_row)))
            self.max_cols = new_cols
    
    def set_cursor(self, row: int, col: int):
        """Set cursor position, ensuring screen is large enough"""
        self.cursor_row = max(0, row)
        self.cursor_col = max(0, col)
        self.ensure_screen_size(self.cursor_row, self.cursor_col)
    
    def move_cursor_up(self, lines: int = 1):
        """Move cursor up by specified lines"""
        self.cursor_row = max(0, self.cursor_row - lines)
    
    def move_cursor_down(self, lines: int = 1):
        """Move cursor down by specified lines"""
        self.cursor_row += lines
        self.ensure_screen_size(self.cursor_row, self.cursor_col)
    
    def move_cursor_forward(self, cols: int = 1):
        """Move cursor forward by specified columns"""
        self.cursor_col += cols
        self.ensure_screen_size(self.cursor_row, self.cursor_col)
    
    def move_cursor_backward(self, cols: int = 1):
        """Move cursor backward by specified columns"""
        self.cursor_col = max(0, self.cursor_col - cols)
    
    def clear_line(self, mode: int = 0):
        """Clear line based on mode: 0=cursor to end, 1=start to cursor, 2=entire line"""
        if self.cursor_row < len(self.screen):
            row = self.screen[self.cursor_row]
            if mode == 0:  # Clear from cursor to end of line
                for i in range(self.cursor_col, len(row)):
                    row[i] = ' '
            elif mode == 1:  # Clear from start of line to cursor
                for i in range(0, min(self.cursor_col + 1, len(row))):
                    row[i] = ' '
            elif mode == 2:  # Clear entire line
                for i in range(len(row)):
                    row[i] = ' '
    
    def clear_screen(self, mode: int = 0):
        """Clear screen based on mode: 0=cursor to end, 1=start to cursor, 2=entire screen"""
        if mode == 2:  # Clear entire screen
            self.screen = []
            self.cursor_row = 0
            self.cursor_col = 0
        # Note: Other modes would require more complex implementation
    
    def insert_text(self, text: str):
        """Insert text at current cursor position"""
        for char in text:
            if char == '\n':
                self.cursor_row += 1
                self.cursor_col = 0
                self.ensure_screen_size(self.cursor_row, self.cursor_col)
            elif char == '\r':
                self.cursor_col = 0
            elif char == '\t':
                # Move to next tab stop (8-character boundaries)
                self.cursor_col = ((self.cursor_col // 8) + 1) * 8
                self.ensure_screen_size(self.cursor_row, self.cursor_col)
            elif ord(char) >= 32:  # Printable character
                self.ensure_screen_size(self.cursor_row, self.cursor_col)
                self.screen[self.cursor_row][self.cursor_col] = char
                self.cursor_col += 1
    
    def process_escape_sequence(self, sequence: str):
        """Process a single ANSI escape sequence"""
        # CSI sequences (Control Sequence Introducer)
        if sequence.startswith('['):
            csi_content = sequence[1:]
            
            # Cursor position (row;col)
            if csi_content.endswith('H') or csi_content.endswith('f'):
                params = csi_content[:-1].split(';') if csi_content[:-1] else ['1', '1']
                row = int(params[0] if params[0] else '1') - 1  # Convert to 0-based
                col = int(params[1] if len(params) > 1 and params[1] else '1') - 1
                self.set_cursor(row, col)
            
            # Cursor up
            elif csi_content.endswith('A'):
                lines = int(csi_content[:-1]) if csi_content[:-1] else 1
                self.move_cursor_up(lines)
            
            # Cursor down
            elif csi_content.endswith('B'):
                lines = int(csi_content[:-1]) if csi_content[:-1] else 1
                self.move_cursor_down(lines)
            
            # Cursor forward
            elif csi_content.endswith('C'):
                cols = int(csi_content[:-1]) if csi_content[:-1] else 1
                self.move_cursor_forward(cols)
            
            # Cursor backward
            elif csi_content.endswith('D'):
                cols = int(csi_content[:-1]) if csi_content[:-1] else 1
                self.move_cursor_backward(cols)
            
            # Move to column (G command)
            elif csi_content.endswith('G'):
                col = int(csi_content[:-1]) if csi_content[:-1] else 1
                self.cursor_col = max(0, col - 1)  # Convert to 0-based
                self.ensure_screen_size(self.cursor_row, self.cursor_col)
            
            # Erase in line
            elif csi_content.endswith('K'):
                mode = int(csi_content[:-1]) if csi_content[:-1] else 0
                self.clear_line(mode)
            
            # Erase in screen
            elif csi_content.endswith('J'):
                mode = int(csi_content[:-1]) if csi_content[:-1] else 0
                self.clear_screen(mode)
            
            # Color and styling codes (SGR) - we ignore these for final text output
            elif csi_content.endswith('m'):
                pass  # Ignore color/style codes
        
        # Handle other escape sequences as needed
        # For now, we'll ignore most other sequences
    
    def process_content(self, content: str) -> str:
        """Process the entire content and return final text"""
        # Pattern to match ANSI escape sequences including character set sequences
        ansi_pattern = r'\x1b\[[0-9;]*[a-zA-Z]|\x1b\[[?][0-9;]*[a-zA-Z]|\x1b\[[?][0-9]*[hl]|\x1b\([AB0]'
        
        i = 0
        while i < len(content):
            # Look for escape sequence
            if content[i] == '\x1b' and i + 1 < len(content):
                # Find the end of the escape sequence
                match = re.match(ansi_pattern, content[i:])
                if match:
                    sequence = match.group(0)
                    self.process_escape_sequence(sequence[1:])  # Remove the ESC character
                    i += len(sequence)
                    continue
            
            # Regular character - add to screen
            if content[i] != '\x1b':
                self.insert_text(content[i])
            
            i += 1
        
        return self.get_final_text()
    
    def get_final_text(self) -> str:
        """Get the final text output from the screen buffer"""
        result_lines = []
        
        # Find the actual content bounds
        last_content_row = -1
        for row_idx in range(len(self.screen)):
            row = self.screen[row_idx]
            # Check if row has any non-space content
            if any(char != ' ' for char in row):
                last_content_row = row_idx
        
        # Extract content up to the last meaningful row
        for row_idx in range(last_content_row + 1):
            if row_idx < len(self.screen):
                row = self.screen[row_idx]
                # Find last non-space character
                last_char = -1
                for col_idx in range(len(row) - 1, -1, -1):
                    if row[col_idx] != ' ':
                        last_char = col_idx
                        break
                
                # Extract the meaningful part of the line
                if last_char >= 0:
                    line = ''.join(row[:last_char + 1])
                else:
                    line = ''
                
                result_lines.append(line.rstrip())
        
        # Remove trailing empty lines
        while result_lines and not result_lines[-1]:
            result_lines.pop()
        
        return '\n'.join(result_lines)

def main():
    if len(sys.argv) != 3:
        print("Usage: python ansi_processor.py <input_file> <output_file>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    try:
        with open(input_file, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        
        processor = ANSIProcessor()
        final_text = processor.process_content(content)
        
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(final_text)
        
        print(f"Processed {input_file} -> {output_file}")
        print(f"Final text length: {len(final_text)} characters")
        
    except FileNotFoundError:
        print(f"Error: File {input_file} not found")
        sys.exit(1)
    except Exception as e:
        print(f"Error processing file: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()