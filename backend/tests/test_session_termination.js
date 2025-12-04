#!/usr/bin/env node

/**
 * Test script to verify that session metadata is saved correctly without extra brackets
 */

import fetch from 'node-fetch';
import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_URL = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000';

async function createSession(title = 'Test Session') {
  const response = await fetch(`${SERVER_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'echo "Test session for issue 351"; sleep 1; echo "Done"',
      title,
      interactive: false,
      save_session_history: true
    })
  });
  
  if (!response.ok) {
    throw new Error(`Failed to create session: ${await response.text()}`);
  }
  
  const session = await response.json();
  console.log(`✓ Created session: ${session.session_id} (${title})`);
  return session;
}

async function waitForSessionCompletion(sessionId) {
  console.log(`  Waiting for session ${sessionId} to complete...`);
  const maxRetries = 20;
  let retries = 0;
  
  while (retries < maxRetries) {
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      const response = await fetch(`${SERVER_URL}/api/sessions/${sessionId}`);
      if (response.ok) {
        const session = await response.json();
        if (!session.is_active) {
          console.log(`✓ Session ${sessionId} completed (exit_code: ${session.exit_code || 'unknown'})`);
          return session;
        }
      }
    } catch (error) {
      // Ignore errors and continue waiting
    }
    
    retries++;
  }
  
  throw new Error(`Session ${sessionId} did not complete within timeout`);
}

async function verifyMetadataFile(sessionId) {
  // Give it a moment for file to be written
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const metadataPath = path.join(__dirname, '..', 'data', 'sessions', `${sessionId}.json`);
  
  try {
    const content = await fs.readFile(metadataPath, 'utf8');
    
    // Try to parse the JSON
    try {
      const metadata = JSON.parse(content);
      console.log(`✓ Metadata file for session ${sessionId} is valid JSON`);
      console.log(`  - session_id: ${metadata.session_id}`);
      console.log(`  - exit_code: ${metadata.exit_code}`);
      console.log(`  - template_parameters: ${JSON.stringify(metadata.template_parameters)}`);
      return true;
    } catch (parseError) {
      console.error(`✗ Metadata file for session ${sessionId} has invalid JSON:`);
      console.error(`  Error: ${parseError.message}`);
      console.error(`  File content preview:`);
      console.error(content.substring(0, 500));
      return false;
    }
  } catch (error) {
    console.error(`✗ Could not read metadata file for session ${sessionId}: ${error.message}`);
    return false;
  }
}

async function runTest() {
  console.log('Testing session termination and metadata saving...\n');
  
  try {
    // Test 1: Create and terminate a session naturally
    console.log('Test 1: Natural session termination');
    const session1 = await createSession('Natural Termination Test');
    await waitForSessionCompletion(session1.session_id);
    const valid1 = await verifyMetadataFile(session1.session_id);
    
    // Test 2: Create multiple sessions to test concurrent termination
    console.log('\nTest 2: Concurrent session terminations');
    const sessions = await Promise.all([
      createSession('Concurrent Test 1'),
      createSession('Concurrent Test 2'),
      createSession('Concurrent Test 3')
    ]);
    
    await Promise.all(sessions.map(s => waitForSessionCompletion(s.session_id)));
    
    const results = await Promise.all(
      sessions.map(s => verifyMetadataFile(s.session_id))
    );
    
    const allValid = valid1 && results.every(r => r === true);
    
    if (allValid) {
      console.log('\n✅ All tests passed! Metadata files are valid JSON without extra brackets.');
    } else {
      console.log('\n❌ Some tests failed. Check the errors above.');
      process.exit(1);
    }
    
  } catch (error) {
    console.error(`\n❌ Test failed with error: ${error.message}`);
    process.exit(1);
  }
}

// Check if server is running
fetch(SERVER_URL)
  .then(() => runTest())
  .catch(() => {
    console.error('Server is not running. Please start the server first.');
    process.exit(1);
  });
