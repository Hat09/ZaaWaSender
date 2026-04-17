// Fix globalStatusCallback overwrite
// on line 421

function yourFunction() {
    // previous code
    const statusCallback = globalStatusCallback; // Save the original callback
    globalStatusCallback = function() {
        // Your new implementation
        // Ensure the original callback is called as needed
        statusCallback(); // Call the original callback if needed
    };
    // your function implementation
}