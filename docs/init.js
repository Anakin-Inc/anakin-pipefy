/* global PipefyApp */
PipefyApp.initCall({
  'card-tab': function () {
    return {
      icon: './card-icon.svg',
      title: 'Anakin',
      url: './card-tab.html',
    };
  },
  'card-buttons': function () {
    return [
      {
        icon: './card-icon.svg',
        text: 'Scrape with Anakin',
        callback: function (p) {
          p.modal({ url: './modal.html', width: '720px', height: '80%' });
        },
      },
    ];
  },
});
