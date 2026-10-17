import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeDocumentSuggestions, documentSuggestions} from '../src/documentAutofill.js';
const reading = {fields:{date:'2026-09-01',number:'F-123',withholding:0,lines:[{base:10000,vat_rate:21}],status:'confirmed'},parties:{expense:{party:'Proveedor',nif:'B12345678'},income:{party:'Cliente',nif:'12345678Z'}}};
test('manual edits, including deliberately cleared values, survive late OCR',()=>{
  const form={kind:'expense',party:'',number:'Manual',lines:[{base:'42.00',vat_deduct:50}]};
  const result=mergeDocumentSuggestions(form,reading,new Set(['party','number','lines']));
  assert.equal(result.party,'');assert.equal(result.number,'Manual');assert.deepEqual(result.lines,form.lines);
  assert.equal(result.date,'2026-09-01');assert.equal(result.withholding,'0.00');assert.equal(result.status,undefined);
});
test('missing suggestions preserve existing amounts; current role selects the counterparty',()=>{
  const form={kind:'income',withholding:'20.00',lines:[{base:'500.00'}]};
  const result=mergeDocumentSuggestions(form,{...reading,fields:{number:'F-123'}},new Set());
  assert.equal(result.party,'Cliente');assert.equal(result.nif,'12345678Z');assert.equal(result.withholding,'20.00');assert.deepEqual(result.lines,form.lines);
  assert.equal(documentSuggestions(reading,'expense').lines[0].base,'100.00');
});

test('classified foreign readings clear unedited OCR tax guesses but retain manual corrections', () => {
  const form = {kind:'expense',date:'2026-01-01',number:'OCR',party:'OCR',nif:'B123',withholding:'15.00',lines:[{base:'100.00',vat_rate:21}]};
  const reading = {classification:{document_type:'invoice',issuer_country:'IE'},fields:{number:'FOREIGN-1'},parties:{expense:{party:'Foreign supplier'}}};
  const result = mergeDocumentSuggestions(form,reading,new Set(['date']));
  assert.equal(result.date,form.date);
  assert.equal(result.party,'Foreign supplier');
  assert.equal(result.withholding,'0.00');
  assert.equal(result.lines[0].base,'0.00');
  assert.equal(result.lines[0].vat_rate,0);
  assert.deepEqual(mergeDocumentSuggestions(form,reading,new Set(['lines'])).lines,form.lines);
});
