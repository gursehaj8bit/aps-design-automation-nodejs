let canMintScopedSas = false;
let sasBlobName = null;
let sasAccess = 'read';

$(document).ready(function () {
    loadConfig();
    listFiles();
    $('#refreshBtn').click(listFiles);
    $('#filterPrefix').keyup(function (e) { if (e.key === 'Enter') listFiles(); });
    $('#uploadBtn').click(uploadFiles);
    $('#uploadFiles').change(syncUploadName);
    $('#generateSasBtn').click(generateSas);
    $('#uploadSasBtn').click(openUploadSas);
    $('#copySasBtn').click(copySas);
    $('#viewModal').on('hidden.bs.modal', function () { $('#viewBody').empty(); });

    $('#files').on('click', 'button[data-action]', function () {
        const name = $(this).closest('tr').attr('data-name');
        const contentType = $(this).closest('tr').attr('data-type');
        switch ($(this).data('action')) {
            case 'view': return viewFile(name, contentType);
            case 'download': return window.location.assign(blobUrl('download', name));
            case 'delete': return deleteFile(name);
            case 'sas': return openSas(name, 'read');
        }
    });
});

function blobUrl(kind, name) {
    return '/api/blob/' + kind + '?name=' + encodeURIComponent(name);
}

function errorText(xhr) {
    return (xhr.responseJSON && xhr.responseJSON.error) || xhr.statusText || 'Request failed';
}

function setStatus(text, isError) {
    $('#status').text(text).toggleClass('text-danger', !!isError).toggleClass('text-muted', !isError);
}

function formatSize(bytes) {
    if (bytes === undefined || bytes === null) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(i ? 1 : 0) + ' ' + units[i];
}

function loadConfig() {
    $.getJSON('/api/blob/config', function (cfg) {
        canMintScopedSas = cfg.canMintScopedSas;
        const missing = [];
        if (!cfg.account) missing.push('AZURE_STORAGE_ACCOUNT_NAME');
        if (!cfg.container) missing.push('AZURE_STORAGE_CONTAINER_NAME');
        if (!cfg.sasTokenSet) missing.push('AZURE_STORAGE_SAS_TOKEN');
        if (missing.length)
            $('#configAlert').text('Set these environment variables and restart the server: ' + missing.join(', ')).show();
        else
            $('#target').text(cfg.account + ' / ' + cfg.container);
    });
}

function listFiles() {
    setStatus('Loading…');
    $.getJSON('/api/blob/files', { prefix: $('#filterPrefix').val() || undefined })
        .done(function (files) {
            const tbody = $('#files tbody').empty();
            if (!files.length)
                tbody.append($('<tr>').append($('<td colspan="4" class="text-muted">').text('No files')));
            files.forEach(function (f) {
                const actions = $('<td class="actions text-right">').append(
                    actionButton('view', 'eye-open', 'View'),
                    actionButton('download', 'download-alt', 'Download'),
                    actionButton('sas', 'link', 'Generate SAS URL'),
                    actionButton('delete', 'trash', 'Delete', 'btn-danger')
                );
                $('<tr>').attr('data-name', f.name).attr('data-type', f.contentType || '').append(
                    $('<td>').text(f.name),
                    $('<td>').text(formatSize(f.size)),
                    $('<td>').text(f.lastModified ? new Date(f.lastModified).toLocaleString() : ''),
                    actions
                ).appendTo(tbody);
            });
            setStatus(files.length + ' file(s)');
        })
        .fail(function (xhr) { setStatus(errorText(xhr), true); });
}

function actionButton(action, icon, title, cls) {
    return $('<button class="btn btn-xs" style="margin-left: 4px;">')
        .addClass(cls || 'btn-default')
        .attr({ 'data-action': action, title: title })
        .append($('<span class="glyphicon">').addClass('glyphicon-' + icon));
}

function uploadFiles() {
    const files = $('#uploadFiles')[0].files;
    if (!files.length) return alert('Choose at least one file');
    const form = new FormData();
    for (let i = 0; i < files.length; i++) form.append('files', files[i]);
    form.append('prefix', $('#uploadPrefix').val());
    if (files.length === 1) form.append('name', $('#uploadName').val());

    const btn = $('#uploadBtn').prop('disabled', true);
    setStatus('Uploading ' + files.length + ' file(s)…');
    $.ajax({ url: '/api/blob/files', type: 'POST', data: form, processData: false, contentType: false })
        .done(function (res) {
            $('#uploadFiles').val('');
            syncUploadName();
            setStatus('Uploaded ' + res.uploaded.length + ' file(s)');
            listFiles();
        })
        .fail(function (xhr) { setStatus(errorText(xhr), true); })
        .always(function () { btn.prop('disabled', false); });
}

// Pre-fills the chosen file's name so it can be edited; a multi-file upload keeps each original name.
function syncUploadName() {
    const files = $('#uploadFiles')[0].files;
    const single = files.length === 1;
    $('#uploadName').prop('disabled', files.length > 1).val(single ? files[0].name : '');
    $('#uploadNameHelp').text(files.length > 1 ? 'Each file keeps its own name when uploading several.' : 'Only when uploading a single file.');
}

function deleteFile(name) {
    if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;
    $.ajax({ url: blobUrl('files', name), type: 'DELETE' })
        .done(function () { setStatus('Deleted ' + name); listFiles(); })
        .fail(function (xhr) { setStatus(errorText(xhr), true); });
}

function viewFile(name, contentType) {
    const url = blobUrl('view', name);
    const body = $('#viewBody').empty();
    $('#viewTitle').text(name);
    if (contentType.indexOf('image/') === 0) {
        body.append($('<img id="viewerImage">').attr('src', url));
    } else if (contentType === 'application/pdf' || contentType.indexOf('text/') === 0 ||
        contentType === 'application/json' || contentType.indexOf('video/') === 0 || contentType.indexOf('audio/') === 0) {
        body.append($('<iframe id="viewerFrame">').attr('src', url));
    } else {
        body.append(
            $('<p>').text('No browser preview for this file type (' + (contentType || 'unknown') + ').'),
            $('<a class="btn btn-default">').attr('href', blobUrl('download', name)).text('Download instead')
        );
    }
    $('#viewModal').modal('show');
}

// The upload URL targets the name the upload form would use: folder + file name.
function openUploadSas() {
    const name = $.trim($('#uploadName').prop('disabled') ? '' : $('#uploadName').val()).replace(/^\/+|\/+$/g, '');
    if (!name) return alert('Enter a file name to generate an upload URL for');
    const prefix = $.trim($('#uploadPrefix').val()).replace(/^\/+|\/+$/g, '');
    openSas(prefix ? prefix + '/' + name : name, 'upload');
}

function openSas(name, access) {
    sasBlobName = name;
    sasAccess = access;
    $('#sasKind').text(access === 'upload' ? 'Upload URL' : 'Download URL');
    $('#sasName').text(name);
    $('#sasUrl').val('');
    $('#sasMeta').text('');
    $('#sasUsageGroup').hide();
    $('#sasExpiryGroup').toggle(canMintScopedSas);
    $('#sasWarning').toggle(!canMintScopedSas).text(canMintScopedSas ? '' :
        'No AZURE_STORAGE_ACCOUNT_KEY is set, so the link reuses the configured SAS token: ' +
        'it carries that token\'s full permissions and expiry. Share it with care.');
    $('#sasModal').modal('show');
}

function generateSas() {
    $.ajax({
        url: '/api/blob/sas', type: 'POST', contentType: 'application/json',
        data: JSON.stringify({ name: sasBlobName, access: sasAccess, expiresInMinutes: $('#sasMinutes').val() })
    })
        .done(function (res) {
            $('#sasUrl').val(res.url).select();
            const expiry = res.expiresOn ? new Date(res.expiresOn).toLocaleString() : 'unknown';
            $('#sasMeta').text('Permissions: ' + (res.permissions || 'unknown') + ' · Expires: ' + expiry);
            if (sasAccess === 'upload') {
                const headers = Object.keys(res.headers).map(function (h) { return '-H "' + h + ': ' + res.headers[h] + '" '; }).join('');
                $('#sasUsage').text('curl -X ' + res.method + ' ' + headers + '--data-binary @<local file> "' + res.url + '"');
                $('#sasUsageGroup').show();
            }
        })
        .fail(function (xhr) { $('#sasMeta').text(errorText(xhr)); });
}

function copySas() {
    const url = $('#sasUrl').val();
    if (!url) return;
    navigator.clipboard.writeText(url).then(function () { $('#sasMeta').append(' · Copied'); });
}
