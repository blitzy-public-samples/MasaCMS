import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Renders the form-builder `form-form` template: the general form attributes block. */
export function formForm(input: { readonly rb: RbLookup }): string {
  return `<span>
		<div class="mura-tb-form" id="formblock-\${fieldid}">
			<div class="mura-tb-header">
				<h2><span id="mura-tb-form-label">${input.rb.rbKey('formbuilder.form')}</span></h2>
			</div>
			<ul class="template-form">
				<li>
					<label for="label">${input.rb.rbKey('formbuilder.form.emailsubject')}</label>
					<input class="text tb-emailsubject" type="text" name="emailsubject" value="" data-label="true">
				</li>
				<li>
					<label for="name">${input.rb.rbKey('formbuilder.form.replyto')}</label>
					<input class="text tb-replyto" type="text" name="replyto" value="" data-label="true">
				</li>
				<li>
					<label for="name">${input.rb.rbKey('formbuilder.form.submitlabel')}</label>
					<input class="text tb-submitlabel" type="text" name="submitlabel" value="" data-label="true">
				</li>
				<li>
					<label for="name">${input.rb.rbKey('formbuilder.form.class')}</label>
					<input class="text tb-class" type="text" name="class" value="" data-label="true">
				</li>
				<li>
					<label for="name-restricted">${input.rb.rbKey('formbuilder.form.nameunrestricted')}</label>
					<input id="tb-name-restricted" class="text tb-class" type="checkbox" name="name-unrestricted" value="1" data-label="true"> *
				</li>
				
				<input id="tb-muraormentities" class="text tb-class" type="hidden" name="muraormentities" value="0" data-label="true">

				<li>
					<div>
					*${input.rb.rbKey('formbuilder.form.nameunrestrictedtip')}
					</div>
					
				</li>



			</ul>
		</div>
	</span>
`;
}
