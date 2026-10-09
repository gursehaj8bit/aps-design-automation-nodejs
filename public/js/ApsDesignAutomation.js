$(document).ready(function () {
    prepareLists();

    $('#clearAccount').click(clearAccount);
    $('#defineActivityShow').click(defineActivityModal);
    $('#createAppBundleActivity').click(createAppBundleActivity);
    $('#refreshActivities').click(listAllActivities);
    $('#refreshWorkitems').click(function () { listWorkitems(); });
    $('#workitemFilters').on('click', 'button', function () {
        $('#workitemFilters button').removeClass('active');
        $(this).addClass('active');
        renderWorkitems();
    });
    $('#workitemSearch').on('input', renderWorkitems);
    $('#workitemWindow').change(function () { listWorkitems(); });

    startConnection();
});

function prepareLists() {
    list('engines', '/api/aps/designautomation/engines');
    list('localBundles', '/api/appbundles');
    listAllActivities();
    listWorkitems();
}

var workitemList = [];
var workitemTimer = null;
var workitemRequest = 0;

var groupLabels = {
    running: 'label-info',
    success: 'label-success',
    failed: 'label-danger',
    cancelled: 'label-default',
    unknown: 'label-warning'
};

// A background refresh only spins the refresh icon; any other load also replaces the table with a
// loading row, since what it held may belong to a different window.
function listWorkitems(background) {
    clearTimeout(workitemTimer);
    var request = ++workitemRequest;
    $('#refreshWorkitems').addClass('spinning');
    if (background !== true)
        $('#workitems tbody').empty().append($('<tr>').append($('<td colspan="6" class="text-muted">').text('Loading…')));
    jQuery.ajax({
        url: '/api/aps/designautomation/workitems',
        data: { days: $('#workitemWindow').val() },
        success: function (res) {
            // A slower, older request must not overwrite the answer to a newer one.
            if (request !== workitemRequest)
                return;
            workitemList = res.workitems;
            // Design Automation keeps workitems for 3 days, so a longer window is cut short server side.
            $('#workitemWindowNote').text(res.coveredDays < res.requestedDays
                ? 'Design Automation keeps workitems for 3 days only; showing all it still holds'
                : '');
            renderWorkitems();
            // Keep polling only while something is still running, so an idle page makes no calls.
            if (workitemList.some(function (w) { return w.group === 'running'; }))
                workitemTimer = setTimeout(function () { listWorkitems(true); }, 10000);
        },
        error: function (xhr) {
            if (request !== workitemRequest)
                return;
            $('#workitems tbody').empty().append($('<tr>').append($('<td colspan="6" class="text-danger">')
                .text((xhr.responseJSON && xhr.responseJSON.diagnostic) || 'Failed to load workitems')));
        },
        complete: function () {
            if (request === workitemRequest)
                $('#refreshWorkitems').removeClass('spinning');
        }
    });
}

function renderWorkitems() {
    var group = $('#workitemFilters .active').data('group');
    var search = $('#workitemSearch').val().trim().toLowerCase();

    $('#workitemFilters button').each(function () {
        var g = $(this).data('group');
        $(this).find('.badge').text(workitemList.filter(function (w) { return g === 'all' || w.group === g; }).length);
    });

    var shown = workitemList.filter(function (w) {
        if (group !== 'all' && w.group !== group)
            return false;
        return !search || [w.id, w.activityId].some(function (v) {
            return v && v.toLowerCase().indexOf(search) !== -1;
        });
    });

    var tbody = $('#workitems tbody').empty();
    if (shown.length === 0)
        tbody.append($('<tr>').append($('<td colspan="6" class="text-muted">').text('Nothing found')));
    shown.forEach(function (w) {
        var report = w.reportUrl && w.group !== 'running'
            ? $('<a target="_blank">').attr('href', w.reportUrl).text('Report')
            : '';
        $('<tr>').append(
            $('<td>').append($('<span class="label">').addClass(groupLabels[w.group]).text(w.status + (w.progress ? ' ' + w.progress : ''))),
            $('<td>').text((w.activityId || '').replace(/^[^.]*\./, '')).attr('title', w.activityId || ''),
            $('<td>').text(w.stats && w.stats.timeQueued ? new Date(w.stats.timeQueued).toLocaleString() : ''),
            $('<td>').text(workitemDuration(w)),
            $('<td>').append($('<code>').text(w.id.substring(0, 8)).attr('title', w.id)),
            $('<td>').append(report)
        ).appendTo(tbody);
    });
}

function workitemDuration(w) {
    if (!w.stats || !w.stats.timeQueued)
        return '';
    var start = new Date(w.stats.timeQueued);
    var end = w.stats && w.stats.timeFinished ? new Date(w.stats.timeFinished)
        : (w.group === 'running' ? new Date() : null);
    if (!end)
        return '';
    var seconds = Math.max(0, Math.round((end - start) / 1000));
    return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
}

function listAllActivities() {
    const tbody = $('#allActivities tbody').empty()
        .append($('<tr>').append($('<td colspan="3" class="text-muted">').text('Loading…')));
    jQuery.ajax({
        url: '/api/aps/designautomation/activities/all',
        success: function (res) {
            $('#ownNickname').text('this app: ' + res.nickname);
            tbody.empty();
            if (res.activities.length === 0)
                tbody.append($('<tr>').append($('<td colspan="3" class="text-muted">').text('Nothing found')));
            res.activities.forEach(function (a) {
                $('<tr>').attr('title', a.id).toggleClass('info', a.nickname === res.nickname).append(
                    $('<td>').text(a.nickname),
                    $('<td>').text(a.name),
                    $('<td>').text(a.alias)
                ).appendTo(tbody);
            });
        },
        error: function (xhr) {
            tbody.empty().append($('<tr>').append($('<td colspan="3" class="text-danger">')
                .text((xhr.responseJSON && xhr.responseJSON.diagnostic) || 'Failed to load activities')));
        }
    });
}

function list(control, endpoint) {
    $('#' + control).find('option').remove().end();
    jQuery.ajax({
        url: endpoint,
        success: function (list) {
            if (list.length === 0)
                $('#' + control).append($('<option>', {
                    disabled: true,
                    text: 'Nothing found'
                }));
            else
                list.forEach(function (item) {
                    $('#' + control).append($('<option>', {
                        value: item,
                        text: item
                    }));
                });
        }
    });
}

function clearAccount() {
    if (!confirm('Clear existing activities & appbundles before start. ' +
        'This is useful if you believe there are wrong settings on your account.' +
        '\n\nYou cannot undo this operation. Proceed?'))
        return;

    jQuery.ajax({
        url: 'api/aps/designautomation/account',
        method: 'DELETE',
        success: function () {
            prepareLists();
            writeLog('Account cleared, all appbundles & activities deleted');
        }
    });
}

function defineActivityModal() {
    $("#defineActivityModal").modal();
}

function createAppBundleActivity() {
    startConnection(function () {
        writeLog("Defining appbundle and activity for " + $('#engines').val());
        $("#defineActivityModal").modal('toggle');
        createAppBundle(function () {
            createActivity(function () {
                prepareLists();
            });
        });
    });
}

function createAppBundle(cb) {
    jQuery.ajax({
        url: 'api/aps/designautomation/appbundles',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({
            zipFileName: $('#localBundles').val(),
            engine: $('#engines').val()
        }),
        success: function (res) {
            writeLog('AppBundle: ' + res.appBundle + ', v' + res.version);
            if (cb)
                cb();
        },
        error: function (xhr, ajaxOptions, thrownError) {
            writeLog(' -> ' + (xhr.responseJSON && xhr.responseJSON.diagnostic ? xhr.responseJSON.diagnostic : thrownError));
        }
    });
}

function createActivity(cb) {
    jQuery.ajax({
        url: 'api/aps/designautomation/activities',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({
            zipFileName: $('#localBundles').val(),
            engine: $('#engines').val()
        }),
        success: function (res) {
            writeLog('Activity: ' + res.activity);
            if (cb)
                cb();
        },
        error: function (xhr, ajaxOptions, thrownError) {
            writeLog(' -> ' + (xhr.responseJSON && xhr.responseJSON.diagnostic ? xhr.responseJSON.diagnostic : thrownError));
        }
    });
}

function writeLog(text) {
    $('#outputlog').append('<div style="border-top: 1px dashed #C0C0C0">' + text + '</div>');
    var elem = document.getElementById('outputlog');
    elem.scrollTop = elem.scrollHeight;
}

var connection;
var connectionId;

function startConnection(onReady) {
    if (connection && connection.connected) {
        if (onReady)
            onReady();
        return;
    }
    connection = io();
    connection.on('connect', function () {
        connectionId = connection.id;
        if (onReady)
            onReady();
    });

    connection.on('downloadResult', function (url) {
        writeLog('<a href="' + url + '">Download result file here</a>');
    });

    connection.on('downloadReport', function (url) {
        writeLog('<a href="' + url + '">Download report file here</a>');
    });

    connection.on('onComplete', function (message) {
        if (typeof message === 'object')
            message = JSON.stringify(message, null, 2);
        writeLog(message);
    });
}
