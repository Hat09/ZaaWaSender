// telegramCommands.js

function buildPairs(data) {
    // Validate data
    if (!Array.isArray(data)) {
        throw new Error('Invalid data format. Expected an array.');
    }

    // Logic for building pairs
    const pairs = [];
    for (let i = 0; i < data.length; i += 2) {
        if (data[i + 1] !== undefined) {
            pairs.push([data[i], data[i + 1]]);
        } else {
            throw new Error('Missing pair data at index ' + i);
        }
    }
    return pairs;
}

function load_script_confirm(data) {
    // Ensure state validation
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid confirmation data.');
    }
    // Additional logic for confirmation
}

function SET_MSG(msg) {
    try {
        // Explicitly convert sender to account object
        const senderAccount = convertToAccountObject(msg.sender);
        // Logic to set message
    } catch (error) {
        console.error('Error in setting message:', error);
    }
}

// Enhancements on the confirmation step
function confirmStep(data) {
    // validate confirmation step
    if (!data.confirmed) {
        throw new Error('Confirmation needed.');
    }
    
    if (!data.user || !data.user.id) {
        throw new Error('User ID not found.');
    }
    
    // Process confirmation further
}