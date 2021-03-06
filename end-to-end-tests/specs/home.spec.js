var assert = require('assert');

const CBIOPORTAL_URL = process.env.CBIOPORTAL_URL.replace(/\/$/, "");

describe('homepage', function() {

    it('it should show dev mode when testing', function() {
        browser.url(CBIOPORTAL_URL);

        browser.localStorage('POST', {key: 'localdev', value: 'true'});
        browser.refresh();

        var devMode = $('.alert-warning');

        devMode.waitForExist(30000);
        assert(browser.getText('.alert-warning').indexOf('dev mode') > 0);
    });

    it('it should have 29 studies in list', function () {
        browser.url(CBIOPORTAL_URL);

        var studies = $('[data-test="cancerTypeListContainer"] > ul > ul');
        
        studies.waitForExist(10000); // same as `browser.waitForExist('.notification', 10000)`
        
        //assert.equal(browser.elements('[@data-test=cancerTypeListContainer] > ul > ul').value.length, 29);
        
    });


    it('should filter study list according to filter text input', function () {
        
        assert.equal(browser.elements('[data-test="cancerTypeListContainer"] > ul > ul').value.length, 29);
        
        var input = $(".autosuggest input[type=text]");

        input.waitForExist(10000); 

        input.setValue('tract');
        
        browser.pause(500);

        assert.equal(browser.elements('[data-test="cancerTypeListContainer"] > ul > ul').value.length, 2);
        
    });
    
    it('when a single study is selected, a case set selector is provided', function(){
        
        var caseSetSelectorClass = '[data-test="CaseSetSelector"]';
        
        var checkBox = $('[data-test="StudySelect"]');

        checkBox.waitForExist(10000);
        
        assert.equal(browser.isExisting(caseSetSelectorClass), false);
        
        browser.click('[data-test="StudySelect"]');

        var caseSetSelector = $(caseSetSelectorClass);
        caseSetSelector.waitForExist(10000);
        
        assert.equal(browser.isExisting(caseSetSelectorClass), true);
        
    });
    
});

describe('patient page', function(){

    it('oncokb indicators show up and hovering produces oncocard', function(){

        browser.url(`${CBIOPORTAL_URL}/case.do#/patient?studyId=ucec_tcga_pub&caseId=TCGA-BK-A0CC`);

        // wait for mutation to exist
        $('span*=PPP2R1A').waitForExist(60000);

        // find oncokb image
        var oncokbIndicator = $('[data-test="oncogenic-icon-image"]');
        oncokbIndicator.waitForExist(30000);

        // move over oncokb image (this is deprecated, but there is no new
        // function yet)
        browser.moveToObject('[data-test="oncogenic-icon-image"]',5,5);

        var oncokbCard = $('[data-test="oncokb-card"]');

        oncokbCard.waitForExist(30000);
        
        assert.equal(browser.getText('.tip-header'), 'PPP2R1A S256F in Uterine Serous Carcinoma/Uterine Papillary Serous Carcinoma');

    });

});
