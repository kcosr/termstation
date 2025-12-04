#!/usr/bin/env node

/**
 * Test script to verify history functionality implementation
 * Tests session creation, history logging, termination, and history retrieval
 */

const SERVER_URL = 'http://localhost:6620';

// Utility function to wait
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to create a session that produces output and terminates
async function createTestSession(command, title = null) {
  const response = await fetch(`${SERVER_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: command,
      working_directory: '/tmp',
      interactive: false,
      cols: 80,
      rows: 24,
      title: title,
      save_session_history: true
    })
  });
  
  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
  }
  
  const session = await response.json();
  console.log(`✓ Created session: ${session.session_id} (${title || 'Untitled'})`);
  return session;
}

// Function to wait for session to complete and get its details
async function waitForSessionCompletion(sessionId, maxWaitSeconds = 10) {
  const startTime = Date.now();
  const maxWaitTime = maxWaitSeconds * 1000;
  
  while (Date.now() - startTime < maxWaitTime) {
    try {
      const response = await fetch(`${SERVER_URL}/api/sessions/${sessionId}`);
      if (response.ok) {
        const session = await response.json();
        if (!session.is_active) {
          console.log(`✓ Session ${sessionId} completed (exit_code: ${session.exit_code || 'unknown'})`);
          return session;
        }
      }
      await sleep(500);
    } catch (error) {
      console.log(`⚠️  Error checking session status: ${error.message}`);
      await sleep(500);
    }
  }
  
  console.log(`⚠️  Session ${sessionId} did not complete within ${maxWaitSeconds} seconds`);
  return null;
}

// Function to get session history metadata (no output payload)
async function getSessionHistory(sessionId) {
  try {
    const response = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/history`);
    if (response.ok) {
      return await response.json();
    } else if (response.status === 404) {
      return null;
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`❌ Error getting history for session ${sessionId}: ${error.message}`);
    return null;
  }
}

// Function to stream session history as raw text
async function getSessionHistoryRaw(sessionId) {
  try {
    const response = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/history/raw`);
    if (response.ok || response.status === 206) {
      return await response.text();
    }
    return '';
  } catch (error) {
    console.error(`❌ Error streaming raw history for session ${sessionId}: ${error.message}`);
    return '';
  }
}

// Function to get all sessions with history
async function getAllSessionsWithHistory() {
  try {
    const response = await fetch(`${SERVER_URL}/api/sessions/history/all`);
    if (response.ok) {
      return await response.json();
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`❌ Error getting all sessions with history: ${error.message}`);
    return [];
  }
}

// Function to search sessions
async function searchSessions(query, filter_type = 'all') {
  try {
    const response = await fetch(`${SERVER_URL}/api/sessions/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, filter_type })
    });
    
    if (response.ok) {
      return await response.json();
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`❌ Error searching sessions: ${error.message}`);
    return [];
  }
}

// Function to delete session history
async function deleteSessionHistory(sessionId) {
  try {
    const response = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/history`, {
      method: 'DELETE'
    });
    
    return response.ok;
  } catch (error) {
    console.error(`❌ Error deleting history for session ${sessionId}: ${error.message}`);
    return false;
  }
}

// Main test function
async function runHistoryTests() {
  console.log('🚀 Starting history functionality tests...\n');
  
  try {
    // Test 1: Create sessions with different outputs
    console.log('1️⃣ Creating test sessions with different outputs...');
    
    const session1 = await createTestSession(
      'echo "Hello from session 1"; echo "This is line 2"; echo "Final line"', 
      'Test Session 1'
    );
    
    const session2 = await createTestSession(
      'echo "Different output"; ls /tmp | head -3; echo "Done with ls"',
      'Directory Listing Test'
    );
    
    const session3 = await createTestSession(
      'echo "Math test"; expr 5 + 3; expr 10 - 4; echo "Math complete"',
      'Math Operations'
    );
    
    // Wait for sessions to complete
    console.log('\n2️⃣ Waiting for sessions to complete...');
    await sleep(1000); // Give sessions time to start
    
    const completed1 = await waitForSessionCompletion(session1.session_id);
    const completed2 = await waitForSessionCompletion(session2.session_id);
    const completed3 = await waitForSessionCompletion(session3.session_id);
    
    // Test 2: Get individual session history
  console.log('\\n3️⃣ Testing individual session history retrieval (metadata + raw)...');
  
  const history1 = await getSessionHistory(session1.session_id);
  const history2 = await getSessionHistory(session2.session_id);
  const history3 = await getSessionHistory(session3.session_id);
  const raw1 = await getSessionHistoryRaw(session1.session_id);
  const raw2 = await getSessionHistoryRaw(session2.session_id);
  const raw3 = await getSessionHistoryRaw(session3.session_id);
  
  console.log(`History 1: ${history1 ? 'Found' : 'Not found'} (raw ${raw1.length} chars)`);
  console.log(`History 2: ${history2 ? 'Found' : 'Not found'} (raw ${raw2.length} chars)`);
  console.log(`History 3: ${history3 ? 'Found' : 'Not found'} (raw ${raw3.length} chars)`);
  
  if (raw1) {
    console.log(`Sample output from session 1: "${raw1.slice(0, 50)}..."`);
  }
    
    // Test 3: Get all sessions with history
    console.log('\\n4️⃣ Testing get all sessions with history...');
    
    const allSessions = await getAllSessionsWithHistory();
    console.log(`Found ${allSessions.length} total sessions (active + terminated)`);
    
    const activeSessions = allSessions.filter(s => s.is_active);
    const terminatedSessions = allSessions.filter(s => !s.is_active);
    console.log(`  - Active: ${activeSessions.length}`);
    console.log(`  - Terminated: ${terminatedSessions.length}`);
    
    // Test 4: Search functionality
    console.log('\\n5️⃣ Testing search functionality...');
    
    const searchResults1 = await searchSessions('Hello');
    const searchResults2 = await searchSessions('Math');
    const searchResults3 = await searchSessions('nonexistent');
    
    console.log(`Search "Hello": ${searchResults1.length} results`);
    console.log(`Search "Math": ${searchResults2.length} results`);
    console.log(`Search "nonexistent": ${searchResults3.length} results`);
    
    // Test 5: Delete session history
    console.log('\\n6️⃣ Testing session history deletion...');
    
    const deleteSuccess = await deleteSessionHistory(session3.session_id);
    console.log(`Delete session 3 history: ${deleteSuccess ? 'Success' : 'Failed'}`);
    
    // Verify deletion
  const deletedHistory = await getSessionHistory(session3.session_id);
  const deletedRaw = await getSessionHistoryRaw(session3.session_id);
  console.log(`Session 3 history after deletion: ${(deletedHistory || deletedRaw) ? 'Still exists' : 'Successfully deleted'}`);
    
    // Test results summary
    console.log('\\n📊 Test Results Summary:');
    console.log('========================');
    
    let passedTests = 0;
    let totalTests = 6;
    
    // Test 1: Session creation
    if (session1 && session2 && session3) {
      console.log('✅ Session creation: PASSED');
      passedTests++;
    } else {
      console.log('❌ Session creation: FAILED');
    }
    
    // Test 2: Session completion
    if (completed1 && completed2 && completed3) {
      console.log('✅ Session completion: PASSED');
      passedTests++;
    } else {
      console.log('❌ Session completion: FAILED');
    }
    
    // Test 3: History retrieval
  if (history1 && history2 && raw1.length > 0 && raw2.length > 0) {
    console.log('✅ History retrieval: PASSED');
    passedTests++;
  } else {
    console.log('❌ History retrieval: FAILED');
  }
    
    // Test 4: All sessions listing
    if (allSessions.length >= 3) {
      console.log('✅ All sessions listing: PASSED');
      passedTests++;
    } else {
      console.log('❌ All sessions listing: FAILED');
    }
    
    // Test 5: Search functionality
    if (searchResults1.length > 0 && searchResults2.length > 0 && searchResults3.length === 0) {
      console.log('✅ Search functionality: PASSED');
      passedTests++;
    } else {
      console.log('❌ Search functionality: FAILED');
    }
    
    // Test 6: History deletion
  if (deleteSuccess && !(deletedHistory || deletedRaw)) {
    console.log('✅ History deletion: PASSED');
    passedTests++;
  } else {
    console.log('❌ History deletion: FAILED');
  }
    
    console.log(`\\nOverall Result: ${passedTests}/${totalTests} tests passed`);
    
    if (passedTests === totalTests) {
      console.log('🎉 All history tests PASSED! History functionality is working correctly.');
    } else {
      console.log('⚠️  Some history tests failed. Check the implementation.');
    }
    
  } catch (error) {
    console.error('❌ Test execution failed:', error);
  }
  
  console.log('\\n🏁 History tests complete');
}

// Start the tests
runHistoryTests();
