'use strict';

jQuery(function () {
    // get the current tab
    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, function (tabs) {
        // error handling
        var showError = function (err) {
            jQuery('.some-error').removeClass('hidden');
            jQuery('.no-error').addClass('hidden');
            jQuery('#error-msg').html(err);
        };

        // set up the spinner
        var startSpinning = function () {
            jQuery('#create-session').prop('disabled', true);
            jQuery('#leave-session').prop('disabled', true);
        };

        var stopSpinning = function () {
            jQuery('#create-session').prop('disabled', false);
            jQuery('#leave-session').prop('disabled', false);
        };

        // send a message to the content script
        var sendMessage = function (type, data, callback) {
            startSpinning();
            chrome.tabs.executeScript(tabs[0].id, {
                file: 'content_script.js'
            }, function () {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: type,
                    data: data
                }, function (response) {
                    stopSpinning();
                    if (response.errorMessage) {
                        showError(response.errorMessage);
                        let f = response.executeFind;
                        if (response.code === 1) {
                            jQuery('#force-find').removeClass('hidden');
                            jQuery('#force-find').addClass('btn btn-warning');
                            jQuery('#force-find').click(() => {
                                chrome.tabs.sendMessage(tabs[0].id, { type: 'forceFind' });
                                setTimeout(() => window.close(), 2000);
                            });
                            return;
                        }
                        setTimeout(() => window.close(), 2000);
                        return;
                    }
                    if (callback) {
                        callback(response);
                    }
                });
            });
        };

        // connected/disconnected state
        var showConnected = function () {
            jQuery('.disconnected').addClass('hidden');
            jQuery('.connected').removeClass('hidden');
            jQuery('#show-chat').prop('checked', true);
        };

        var showDisconnected = function () {
            jQuery('.disconnected').removeClass('hidden');
            jQuery('.connected').addClass('hidden');
        };

        // get the session if there is one
        sendMessage('getInitData', {
            version: chrome.app.getDetails().version
        }, function (initData) {
            // parse the video ID from the URL
            // var videoId = parseInt(tabs[0].url.match(/^.*\/([0-9]+)\??.*/)[1]);

            // initial state
            if (initData.errorMessage) {
                showError(initData.errorMessage);
                return;
            }
            if (initData.sessionId === null) {
                var sessionIdFromUrl;
                if (sessionIdFromUrl) {
                    sendMessage('joinSession', {
                    }, function (response) {
                        showConnected();
                    });
                }
            } else {
                showConnected();
            }
            jQuery('#show-chat').prop('checked', initData.chatVisible);

            // listen for clicks on the "Create session" button
            jQuery('#create-session').click(function () {
                sendMessage('createSession', {
                }, function (response) {
                    showConnected();
                });
            });

            // listen for clicks on the "Leave session" button
            jQuery('#leave-session').click(function () {
                sendMessage('leaveSession', {}, function (response) {
                    showDisconnected();
                });
            });

            // listen for clicks on the "Show chat" checkbox
            jQuery('#show-chat').change(function () {
                sendMessage('showChat', { visible: jQuery('#show-chat').is(':checked') }, null);
            });

            // listen for clicks on the share URL box

            // listen for clicks on the "Copy URL" link
        });
    }
    );
});
